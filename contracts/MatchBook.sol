// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MatchBook — every ranked match, committed, settled, attested and
/// finalized on litVM by transaction. BUILD-SPEC v0.3 §6, §11.
///
/// The event log of this contract IS the delta set: a ladder is a fold over
/// `Finalized` results in block order, by any node or by a browser on RPC
/// alone. Every transaction here is a claim with a locked bond behind it
/// (NodeStake v3), and the contract — never a wallet — slashes the bond of a
/// claim the panel rejected.
///
///   COMMIT    the drawn host, before play: who plays (descriptorHash), which
///             build, and the three drawn witnesses. The panel is on chain
///             before a tick is played.
///   SETTLE    the host, within settleWindow: the result commitment
///             (protocol/result.js resultHash), the ledger's sha256, the
///             participants, scores and custodians — all in the event.
///   ATTEST    each panel witness, within attestWindow: the resultHash IT
///             reached by its own replay. A different hash is a dispute —
///             the same call, a different value.
///   FINALIZE  anyone, after the window (or as soon as all three answered):
///             two or more attests on the host's hash and NO dissent → final.
///             One or zero answers and no dissent → the window is extended
///             once (witness liveness is not a dispute). Any dissent, or
///             still too few after the extension → escalating: a future
///             block is named as the draw seed.
///   ESCALATE  once that block exists, anyone posts the full ledger (sha256
///             must match) and the contract seats NINE from the enrolled
///             pool, stake-weighted, one seat per operator, excluding both
///             panels' operators, and SNAPSHOTS their weights. They attest
///             within escalationWindow; the stake-weighted strict majority of
///             the snapshot decides; every key on either panel that voted
///             against it, and a host the majority rejected, is slashed a
///             fraction of its bond. Too few eligible nodes to seat nine →
///             void, nobody slashed (the honest answer when the network is
///             too small to adjudicate).
///   EXPIRE    anyone: a commit never settled, or an escalation nobody fed
///             the ledger, is voided after its window. No state is forever.
///
/// What the contract cannot check, stated: that the committed panel is the
/// one placement.js would have drawn (the client refuses to launch a match
/// whose commit disagrees with its own draw; the panel keys must still be
/// eligible, distinct, and under operators other than the host's), and that
/// a result is correct — only that independent bonded replays agree. The
/// escalation seed is the hash of a block named BEFORE anyone can call
/// escalate(), so a caller cannot pick a block that seats friends; a
/// sequencer that also runs nodes still could (litVM documents blockhash as
/// not secure against it, §5.2) — the VRF seam.
interface INodeStakeV3 {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
    function witnessEligible(bytes32 nodeKey) external view returns (bool);
    function mayActFor(bytes32 nodeKey, address who) external view returns (bool);
    function slash(bytes32 nodeKey, uint16 bps, bytes32 reason) external returns (uint256 cut);
}

contract MatchBook {
    enum Status { None, Committed, Settled, Final, Void, Escalating, Escalated }

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
        uint8   attests;        // panel members that answered
        uint8   agreeing;       // of which agreed with the host's hash
        bool    extended;       // the attest window was extended once for liveness
        uint64  finalizedAt;    // when finalize() escalated (the expire clock)
        uint64  drawBlock;      // the block whose hash seeds the nine
        uint64  escalatedAt;    // when the nine were seated
        Status  status;
    }

    struct Params {
        uint64 settleWindow;       // seconds after commit for settle()
        uint64 attestWindow;       // seconds after settle for the panel
        uint64 escalationWindow;   // seconds after escalate for the nine; also the time allowed to feed the ledger
        uint64 drawDelay;          // blocks after finalize() before the seed block
        uint16 hostSlashBps;       // of the host's bond, when the majority rejects its result
        uint16 witnessSlashBps;    // of a witness's bond, when it voted against the majority
    }

    INodeStakeV3 public stake;
    address public admin;
    Params public params;
    uint8 public constant PANEL = 3;
    uint8 public constant ESCALATION_PANEL = 9;

    mapping(bytes32 => Match) internal matches; // the auto-getter would return 15 values: stack too deep. matchOf() returns the struct.
    mapping(bytes32 => mapping(bytes32 => bytes32)) public voteOf;     // matchId → witnessKey → hash attested (0 = none)
    mapping(bytes32 => mapping(bytes32 => uint256)) public weightOf;   // matchId → escalation seat → stake AT THE DRAW
    mapping(bytes32 => bytes32[]) private _nine;

    /// The witness pool for escalation draws: keys whose operators opted in.
    bytes32[] private _pool;
    mapping(bytes32 => uint256) private _poolIndex; // key → index+1

    event Committed(bytes32 indexed matchId, bytes32 indexed rulesetId, bytes32 indexed hostKey, bytes32 descriptorHash, bytes32[3] panel);
    event Settled(bytes32 indexed matchId, bytes32 indexed rulesetId, bytes32 indexed hostKey, bytes32 resultHash, bytes32 ledgerHash, bytes32 buildHash, bytes32[] participants, int64[] scores, bytes32[] custodians);
    event Attested(bytes32 indexed matchId, bytes32 indexed witnessKey, bytes32 resultHash, bool agrees, bool escalation);
    event Extended(bytes32 indexed matchId, uint64 until);
    event Escalating(bytes32 indexed matchId, uint64 drawBlock, uint64 feedBy);
    event Escalated(bytes32 indexed matchId, bytes32 ledgerHash, bytes32[] panel, uint256[] weights);
    event Finalized(bytes32 indexed matchId, bytes32 indexed rulesetId, bytes32 finalHash, Status status);
    event Enrolled(bytes32 indexed nodeKey, bool enrolled);
    event ParamsUpdated(address stake, Params params, address admin);

    error NotAdmin();
    error NotAllowed();
    error WrongStatus(Status have);
    error WindowClosed();
    error WindowOpen();
    error BadPanel();
    error AlreadyVoted();
    error NotOnPanel();
    error LedgerMismatch();
    error ZeroHash();
    error SeedNotReady(uint64 drawBlock);
    error SeedExpired(uint64 drawBlock);
    error BadParams();

    constructor(INodeStakeV3 stake_, Params memory p, address admin_) { _setParams(stake_, p, admin_); }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }

    /// NodeStake.unbondingPeriod must exceed this (BUILD-SPEC §2.2): the
    /// attest window can be extended once, and the escalation window runs
    /// twice (feeding the ledger, then the nine).
    function totalWindow() external view returns (uint64) { return params.settleWindow + 2 * params.attestWindow + 2 * params.escalationWindow; }

    // ------------------------------------------------------------ pool

    function enroll(bytes32 nodeKey) external {
        if (!stake.mayActFor(nodeKey, msg.sender)) revert NotAllowed();
        if (_poolIndex[nodeKey] == 0) { _pool.push(nodeKey); _poolIndex[nodeKey] = _pool.length; emit Enrolled(nodeKey, true); }
    }
    function withdraw(bytes32 nodeKey) external {
        if (!stake.mayActFor(nodeKey, msg.sender)) revert NotAllowed();
        uint256 i = _poolIndex[nodeKey];
        if (i == 0) return;
        bytes32 last = _pool[_pool.length - 1];
        _pool[i - 1] = last; _poolIndex[last] = i;
        _pool.pop(); delete _poolIndex[nodeKey];
        emit Enrolled(nodeKey, false);
    }
    function pool() external view returns (bytes32[] memory) { return _pool; }

    // ------------------------------------------------------------ lifecycle

    function commit(bytes32 matchId, bytes32 descriptorHash, bytes32 rulesetId, bytes32 hostKey, bytes32[3] calldata panel) external {
        Match storage m = matches[matchId];
        if (m.status != Status.None) revert WrongStatus(m.status);
        if (descriptorHash == bytes32(0)) revert ZeroHash();
        if (!stake.mayActFor(hostKey, msg.sender)) revert NotAllowed();
        (address hostOp, , bool hostActive) = stake.standingOf(hostKey);
        if (!hostActive) revert NotAllowed();
        address[3] memory ops;
        for (uint256 i = 0; i < PANEL; i++) {
            bytes32 w = panel[i];
            if (w == hostKey || !stake.witnessEligible(w)) revert BadPanel();
            (ops[i], , ) = stake.standingOf(w);
            if (ops[i] == hostOp) revert BadPanel();
            for (uint256 j = 0; j < i; j++) if (panel[j] == w || ops[j] == ops[i]) revert BadPanel();
        }
        m.descriptorHash = descriptorHash; m.rulesetId = rulesetId; m.hostKey = hostKey; m.hostOperator = hostOp;
        m.panel = panel; m.committedAt = uint64(block.timestamp); m.status = Status.Committed;
        emit Committed(matchId, rulesetId, hostKey, descriptorHash, panel);
    }

    function settle(bytes32 matchId, bytes32 resultHash, bytes32 ledgerHash, bytes32 buildHash, bytes32[] calldata participants, int64[] calldata scores, bytes32[] calldata custodians) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Committed) revert WrongStatus(m.status);
        if (!stake.mayActFor(m.hostKey, msg.sender)) revert NotAllowed();
        if (block.timestamp > m.committedAt + params.settleWindow) revert WindowClosed();
        if (resultHash == bytes32(0) || ledgerHash == bytes32(0)) revert ZeroHash();
        require(participants.length == scores.length, "scores");
        m.resultHash = resultHash; m.ledgerHash = ledgerHash; m.settledAt = uint64(block.timestamp); m.status = Status.Settled;
        _emitSettled(matchId, m, buildHash, participants, scores, custodians);
    }
    function _emitSettled(bytes32 matchId, Match storage m, bytes32 buildHash, bytes32[] calldata participants, int64[] calldata scores, bytes32[] calldata custodians) internal {
        emit Settled(matchId, m.rulesetId, m.hostKey, m.resultHash, m.ledgerHash, buildHash, participants, scores, custodians);
    }

    /// A witness's own result. `resultHash != the host's` is a dispute.
    function attest(bytes32 matchId, bytes32 witnessKey, bytes32 resultHash) external {
        Match storage m = matches[matchId];
        if (!stake.mayActFor(witnessKey, msg.sender)) revert NotAllowed();
        if (resultHash == bytes32(0)) revert ZeroHash();
        if (voteOf[matchId][witnessKey] != bytes32(0)) revert AlreadyVoted();
        bool agrees = resultHash == m.resultHash;
        if (m.status == Status.Settled) {
            if (block.timestamp > m.settledAt + params.attestWindow) revert WindowClosed();
            if (!_onPanel(m, witnessKey)) revert NotOnPanel();
            voteOf[matchId][witnessKey] = resultHash;
            m.attests++;
            if (agrees) m.agreeing++;
            emit Attested(matchId, witnessKey, resultHash, agrees, false);
        } else if (m.status == Status.Escalated) {
            if (block.timestamp > m.escalatedAt + params.escalationWindow) revert WindowClosed();
            if (weightOf[matchId][witnessKey] == 0) revert NotOnPanel();
            voteOf[matchId][witnessKey] = resultHash;
            emit Attested(matchId, witnessKey, resultHash, agrees, true);
        } else revert WrongStatus(m.status);
    }

    /// After the attest window — or as soon as all three answered.
    function finalize(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Settled) revert WrongStatus(m.status);
        bool windowOver = block.timestamp > m.settledAt + params.attestWindow;
        if (!windowOver && m.attests < PANEL) revert WindowOpen();
        bool dissent = m.agreeing != m.attests;
        if (!dissent && m.agreeing >= 2) {
            m.status = Status.Final;
            emit Finalized(matchId, m.rulesetId, m.resultHash, Status.Final);
            return;
        }
        if (!dissent && !m.extended) {
            // liveness, not a dispute: give the absent witnesses one more window
            m.extended = true; m.settledAt = uint64(block.timestamp);
            emit Extended(matchId, m.settledAt + params.attestWindow);
            return;
        }
        m.status = Status.Escalating;
        m.finalizedAt = uint64(block.timestamp);
        m.drawBlock = uint64(block.number) + params.drawDelay;
        emit Escalating(matchId, m.drawBlock, m.finalizedAt + params.escalationWindow);
    }

    /// Anyone (a custodian, typically) posts the ledger so it can no longer
    /// be withheld, and the contract seats nine — seeded by the hash of the
    /// block finalize() named, which nobody could choose.
    function escalate(bytes32 matchId, bytes calldata ledger) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Escalating) revert WrongStatus(m.status);
        if (block.timestamp > m.finalizedAt + params.escalationWindow) revert WindowClosed();
        if (block.number <= m.drawBlock) revert SeedNotReady(m.drawBlock);
        bytes32 bh = blockhash(m.drawBlock);
        if (bh == bytes32(0)) revert SeedExpired(m.drawBlock); // more than 256 blocks ago: expire() instead
        if (sha256(ledger) != m.ledgerHash) revert LedgerMismatch();
        (bytes32[] memory drawn, uint256[] memory weights) = _draw(matchId, m, keccak256(abi.encodePacked(bh, matchId)));
        if (drawn.length < ESCALATION_PANEL) { _void(matchId, m); return; }
        for (uint256 i = 0; i < drawn.length; i++) { _nine[matchId].push(drawn[i]); weightOf[matchId][drawn[i]] = weights[i]; }
        m.escalatedAt = uint64(block.timestamp);
        m.status = Status.Escalated;
        emit Escalated(matchId, m.ledgerHash, drawn, weights);
    }

    /// After the escalation window: the stake-weighted strict majority of
    /// the SNAPSHOTTED weights wins.
    function resolve(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Escalated) revert WrongStatus(m.status);
        if (block.timestamp <= m.escalatedAt + params.escalationWindow) revert WindowOpen();
        bytes32[] storage nine = _nine[matchId];
        bytes32 best; uint256 bestWeight; uint256 totalVoted;
        for (uint256 i = 0; i < nine.length; i++) {
            bytes32 hsh = voteOf[matchId][nine[i]];
            if (hsh == bytes32(0)) continue;
            totalVoted += weightOf[matchId][nine[i]];
            uint256 s;
            for (uint256 j = 0; j < nine.length; j++) if (voteOf[matchId][nine[j]] == hsh) s += weightOf[matchId][nine[j]];
            if (s > bestWeight) { bestWeight = s; best = hsh; }
        }
        if (best == bytes32(0) || bestWeight * 2 <= totalVoted) { _void(matchId, m); return; }
        for (uint256 i = 0; i < PANEL; i++) _slashIfAgainst(matchId, m.panel[i], best);
        for (uint256 i = 0; i < nine.length; i++) _slashIfAgainst(matchId, nine[i], best);
        if (best == m.resultHash) {
            m.status = Status.Final;
            emit Finalized(matchId, m.rulesetId, best, Status.Final);
        } else {
            stake.slash(m.hostKey, params.hostSlashBps, matchId);
            m.status = Status.Void;
            emit Finalized(matchId, m.rulesetId, best, Status.Void);
        }
    }

    /// No state is forever: a commit the host never settled, or an
    /// escalation nobody fed the ledger within its window (or whose seed
    /// block aged out), is voided by anyone. Nobody is slashed here — a host
    /// that abandons matches, or custodians that withhold a ledger, are the
    /// custody challenger's business (§11.5).
    function expire(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.status == Status.Committed) {
            if (block.timestamp <= m.committedAt + params.settleWindow) revert WindowOpen();
        } else if (m.status == Status.Escalating) {
            bool fed = block.timestamp <= m.finalizedAt + params.escalationWindow;
            bool seedAlive = block.number <= m.drawBlock || blockhash(m.drawBlock) != bytes32(0);
            if (fed && seedAlive) revert WindowOpen();
        } else revert WrongStatus(m.status);
        _void(matchId, m);
    }

    // ------------------------------------------------------------ reads

    function matchOf(bytes32 matchId) external view returns (Match memory) { return matches[matchId]; }
    function panelOf(bytes32 matchId) external view returns (bytes32[3] memory) { return matches[matchId].panel; }
    function escalationPanelOf(bytes32 matchId) external view returns (bytes32[] memory) { return _nine[matchId]; }
    function statusOf(bytes32 matchId) external view returns (Status status, bytes32 resultHash, uint8 attests, uint8 agreeing) {
        Match storage m = matches[matchId];
        return (m.status, m.resultHash, m.attests, m.agreeing);
    }

    // ------------------------------------------------------------ internals

    function _onPanel(Match storage m, bytes32 key) internal view returns (bool) {
        return m.panel[0] == key || m.panel[1] == key || m.panel[2] == key;
    }
    function _void(bytes32 matchId, Match storage m) internal {
        m.status = Status.Void;
        emit Finalized(matchId, m.rulesetId, bytes32(0), Status.Void);
    }
    function _slashIfAgainst(bytes32 matchId, bytes32 key, bytes32 majority) internal {
        bytes32 v = voteOf[matchId][key];
        if (v != bytes32(0) && v != majority) stake.slash(key, params.witnessSlashBps, matchId);
    }

    struct Draw { bytes32[] cand; address[] ops; uint256[] w; uint256 c; uint256 total; }

    /// The eligible candidates: every enrolled key except the host, the
    /// first panel, and every key under any of their operators. Each
    /// candidate's operator and stake are read ONCE (the pool may be large;
    /// the draw must fit a block).
    function _candidates(Match storage m) internal view returns (Draw memory d) {
        uint256 n = _pool.length;
        d.cand = new bytes32[](n); d.ops = new address[](n); d.w = new uint256[](n);
        address[4] memory excluded = [m.hostOperator, address(0), address(0), address(0)];
        for (uint256 i = 0; i < PANEL; i++) (excluded[i + 1], , ) = stake.standingOf(m.panel[i]);
        for (uint256 i = 0; i < n; i++) {
            bytes32 k = _pool[i];
            if (k == m.hostKey || _onPanel(m, k) || !stake.witnessEligible(k)) continue;
            (address op, uint256 amt, ) = stake.standingOf(k);
            if (amt == 0 || op == excluded[0] || op == excluded[1] || op == excluded[2] || op == excluded[3]) continue;
            d.cand[d.c] = k; d.ops[d.c] = op; d.w[d.c] = amt; d.c++; d.total += amt;
        }
    }

    /// Stake-weighted draw without replacement, one seat per operator.
    /// Returns fewer than nine when the pool cannot seat them.
    function _draw(bytes32, Match storage m, bytes32 seed) internal view returns (bytes32[] memory out, uint256[] memory weights) {
        Draw memory d = _candidates(m);
        if (d.c < ESCALATION_PANEL) return (new bytes32[](d.c), new uint256[](d.c));
        out = new bytes32[](ESCALATION_PANEL); weights = new uint256[](ESCALATION_PANEL);
        for (uint256 pick = 0; pick < ESCALATION_PANEL; pick++) {
            if (d.total == 0) return (_shrink(out, pick), _shrinkW(weights, pick)); // ran out of distinct operators: the caller voids
            uint256 r = uint256(keccak256(abi.encodePacked(seed, pick))) % d.total;
            uint256 chosen = _pickIndex(d, r);
            out[pick] = d.cand[chosen]; weights[pick] = d.w[chosen];
            address chosenOp = d.ops[chosen];
            for (uint256 i = 0; i < d.c; i++) if (d.w[i] != 0 && d.ops[i] == chosenOp) { d.total -= d.w[i]; d.w[i] = 0; }
        }
    }
    function _pickIndex(Draw memory d, uint256 r) internal pure returns (uint256) {
        uint256 acc = 0;
        for (uint256 i = 0; i < d.c; i++) { if (d.w[i] == 0) continue; acc += d.w[i]; if (r < acc) return i; }
        return 0;
    }
    function _shrink(bytes32[] memory a, uint256 len) internal pure returns (bytes32[] memory b) { b = new bytes32[](len); for (uint256 i = 0; i < len; i++) b[i] = a[i]; }
    function _shrinkW(uint256[] memory a, uint256 len) internal pure returns (uint256[] memory b) { b = new uint256[](len); for (uint256 i = 0; i < len; i++) b[i] = a[i]; }

    // ------------------------------------------------------------ admin

    function _setParams(INodeStakeV3 stake_, Params memory p, address admin_) internal {
        if (address(stake_) == address(0) || admin_ == address(0)) revert BadParams();
        if (p.hostSlashBps > 10_000 || p.witnessSlashBps > 10_000 || p.drawDelay == 0 || p.drawDelay > 200 || p.attestWindow == 0 || p.escalationWindow == 0) revert BadParams();
        stake = stake_; params = p; admin = admin_;
        emit ParamsUpdated(address(stake_), p, admin_);
    }
    function setParams(INodeStakeV3 stake_, Params calldata p, address admin_) external onlyAdmin { _setParams(stake_, p, admin_); }
    function adminIsContract() external view returns (bool) { return admin.code.length > 0; }
}
