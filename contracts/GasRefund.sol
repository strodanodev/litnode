// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The two reads GasRefund needs from MatchBook. Field order mirrors MatchBook.Match exactly: matchOf()
/// returns that struct, and the ABI decodes it by position.
interface IMatchBookForRefund {
    struct Match {
        bytes32 descriptorHash;
        bytes32 rulesetId;
        bytes32 hostKey;
        address hostOperator;
        bytes32[3] panel;
        uint64  committedAt;
        bytes32 resultHash;
        bytes32 ledgerHash;
        uint64  settledAt;
        uint8   attests;
        uint8   agreeing;
        bool    extended;
        uint64  finalizedAt;
        uint64  drawBlock;
        uint64  escalatedAt;
        uint8   status;          // MatchBook.Status; 3 = Final
    }
    function matchOf(bytes32 matchId) external view returns (Match memory);
    function voteOf(bytes32 matchId, bytes32 witnessKey) external view returns (bytes32);
}

interface INodeStakeForRefund {
    function nodeOf(bytes32 nodeKey) external view returns (address operator, address delegate, uint256 amount, uint64 bondedSince, uint64 unbondAt, bool active, bool eligible);
    function mayActFor(bytes32 nodeKey, address who) external view returns (bool);
}

/// @title GasRefund — the treasury pays back the gas a ranked match cost the nodes that served it.
/// @notice Hosting and witnessing a ranked match costs each node real gas: the host sends commit, settle
/// and finalize, each panel witness sends attest. Volunteers will not keep refilling hot keys to referee
/// strangers' games, and a key that runs dry quietly turns its matches casual. The treasury funds this
/// contract (plain transfers of the native coin); once MatchBook says a match is FINAL, anyone may call
/// claim(matchId) and the contract pays, into each node's delegate (the hot key that spent the gas):
///   the host:                 hostGas    × price × refundBps
///   each AGREEING witness:    witnessGas × price × refundBps   (an absent or dissenting seat: nothing)
///   the seat that claims:     + claimGas × price × refundBps
/// with price = min(block.basefee, maxPriceWei). Once per match; nothing for a void or unfinished match;
/// at most dailyCapWei per node key per UTC day. refundBps below 100 % keeps staged matches between
/// colluding operators a cost to them rather than a free drain on the treasury. No publisher, server or
/// signer is involved: nodes claim for themselves (node/matchbook.js).
contract GasRefund {
    struct Params {
        uint64  hostGas;      // gas the host spends on one ranked match: commit + settle + finalize
        uint64  witnessGas;   // gas one witness spends: attest
        uint64  claimGas;     // gas the claim itself costs the seat that sends it
        uint16  refundBps;    // share of that gas refunded, in basis points (8000 = 80 %)
        uint128 maxPriceWei;  // the most one unit of gas is refunded at
        uint128 dailyCapWei;  // the most one node key receives per UTC day
    }

    uint8 internal constant FINAL = 3;

    IMatchBookForRefund public immutable matchBook;
    INodeStakeForRefund public immutable stake;
    address public admin;
    Params public params;
    bool public paused;
    mapping(bytes32 => bool) public claimed;                              // matchId → refunded
    mapping(bytes32 => mapping(uint256 => uint256)) public refundedOn;    // nodeKey → UTC day → wei
    bool private entered;

    event Funded(address indexed from, uint256 amount);
    event Refunded(bytes32 indexed matchId, bytes32 indexed nodeKey, address indexed to, uint8 role, uint256 amount);
    event Claimed(bytes32 indexed matchId, address indexed by, uint256 total, uint256 price);
    event ParamsUpdated(Params params, address admin);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    error NotAdmin();
    error NotFinal(uint8 status);
    error AlreadyClaimed();
    error IsPaused();
    error BadParams();
    error NotYours();
    error Underfunded(uint256 need, uint256 have);
    error Reentry();

    constructor(IMatchBookForRefund matchBook_, INodeStakeForRefund stake_, Params memory p, address admin_) {
        matchBook = matchBook_;
        stake = stake_;
        _setParams(p, admin_);
    }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }
    modifier guarded() { if (entered) revert Reentry(); entered = true; _; entered = false; }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    uint8 public constant ROLE_HOST = 0;
    uint8 public constant ROLE_WITNESS = 1;

    /// What claim(matchId) would pay now, seat by seat (host first, then the three panel seats; an
    /// unpaid seat has amount 0), the gas price it uses and the total. `callerKey` is the node key the
    /// claimer acts for (bytes32(0) for none): that seat also gets claimGas.
    function quote(bytes32 matchId, bytes32 callerKey) external view returns (bytes32[4] memory keys, uint256[4] memory amounts, uint256 total, uint256 price) {
        return _quote(matchId, matchBook.matchOf(matchId), callerKey);
    }
    function _quote(bytes32 matchId, IMatchBookForRefund.Match memory m, bytes32 callerKey) internal view returns (bytes32[4] memory keys, uint256[4] memory amounts, uint256 total, uint256 price) {
        if (m.status != FINAL) return (keys, amounts, 0, 0);
        price = block.basefee < params.maxPriceWei ? block.basefee : params.maxPriceWei;
        uint256 day = block.timestamp / 1 days;
        keys[0] = m.hostKey;
        amounts[0] = _capped(m.hostKey, day, _gasCost(params.hostGas + (callerKey == m.hostKey ? params.claimGas : 0), price));
        for (uint256 i = 0; i < 3; i++) {
            bytes32 w = m.panel[i];
            keys[i + 1] = w;
            if (matchBook.voteOf(matchId, w) != m.resultHash) continue; // absent or dissenting: nothing
            amounts[i + 1] = _capped(w, day, _gasCost(params.witnessGas + (callerKey == w ? params.claimGas : 0), price));
        }
        for (uint256 i = 0; i < 4; i++) total += amounts[i];
    }

    /// Pay the gas refunds of one FINAL match. Anyone may call; `callerKey` names the node the caller acts
    /// for (its operator or delegate) so that seat's claim gas is refunded too, or bytes32(0).
    function claim(bytes32 matchId, bytes32 callerKey) external guarded {
        if (paused) revert IsPaused();
        if (claimed[matchId]) revert AlreadyClaimed();
        IMatchBookForRefund.Match memory m = matchBook.matchOf(matchId);
        if (m.status != FINAL) revert NotFinal(m.status);
        if (callerKey != bytes32(0) && !stake.mayActFor(callerKey, msg.sender)) revert NotYours();
        (bytes32[4] memory keys, uint256[4] memory amounts, uint256 total, uint256 price) = _quote(matchId, m, callerKey);
        if (total > address(this).balance) revert Underfunded(total, address(this).balance);
        claimed[matchId] = true;
        uint256 day = block.timestamp / 1 days;
        uint256 paid = 0;
        for (uint256 i = 0; i < 4; i++) {
            if (amounts[i] == 0) continue;
            (address operator, address delegate, , , , , ) = stake.nodeOf(keys[i]);
            address to = delegate != address(0) ? delegate : operator;
            if (to == address(0)) continue; // a key no one holds any more: its share stays in the treasury
            refundedOn[keys[i]][day] += amounts[i];
            paid += amounts[i];
            (bool ok, ) = to.call{ value: amounts[i] }("");
            if (!ok) { refundedOn[keys[i]][day] -= amounts[i]; paid -= amounts[i]; continue; } // a contract that refuses: skipped, not a revert for the others
            emit Refunded(matchId, keys[i], to, i == 0 ? ROLE_HOST : ROLE_WITNESS, amounts[i]);
        }
        emit Claimed(matchId, msg.sender, paid, price);
    }

    function _gasCost(uint256 gasUnits, uint256 price) internal view returns (uint256) {
        return gasUnits * price * params.refundBps / 10_000;
    }
    function _capped(bytes32 key, uint256 day, uint256 amount) internal view returns (uint256) {
        uint256 spent = refundedOn[key][day];
        if (spent >= params.dailyCapWei) return 0;
        uint256 left = params.dailyCapWei - spent;
        return amount < left ? amount : left;
    }

    // ------------------------------------------------------------ admin (the treasury's custodian)

    function setParams(Params calldata p, address admin_) external onlyAdmin { _setParams(p, admin_); }
    function setPaused(bool paused_) external onlyAdmin { paused = paused_; emit PausedSet(paused_); }
    /// Take funds back out (to the treasury, a new contract, …). Refunds already paid are not touched.
    function withdraw(address payable to, uint256 amount) external onlyAdmin {
        (bool ok, ) = to.call{ value: amount }("");
        require(ok, "withdraw");
        emit Withdrawn(to, amount);
    }

    /// Bounded: at most 100 %, at most 2M gas a seat, a price cap no higher than 1000 gwei.
    function _setParams(Params memory p, address admin_) internal {
        if (admin_ == address(0)) revert BadParams();
        if (p.refundBps > 10_000 || p.hostGas > 2_000_000 || p.witnessGas > 2_000_000 || p.claimGas > 2_000_000 || p.maxPriceWei > 1_000 gwei) revert BadParams();
        params = p;
        admin = admin_;
        emit ParamsUpdated(p, admin_);
    }
}
