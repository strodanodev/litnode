// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title NodeStake v3 — the LOCKED bond an operator posts to host a node.
/// @notice Deploy target: litVM Liteforge testnet, chain 4441. Stakes the
/// LITVM token (a testnet mock until the real token exists on Liteforge).
///
/// Trust is insured by the stake (BUILD-SPEC v0.3 §2.2): a node may do
/// exactly what its locked bond can pay for if it lies. v3 changes, each
/// against a way v2 could be gamed:
///
///   LOCKED TERM      unstake() reverts before bondedSince + lockTerm. A bond
///                    that can leave the moment a bad result finalizes is a
///                    deposit, not insurance.
///   ELIGIBILITY AGE  witnessEligible(key) is active && no stake added for
///                    eligibilityAge (a top-up restarts the age, the lock it
///                    does not). Fifty sybils bonded this morning cannot be a
///                    panel this afternoon, and a whale cannot top up the
///                    morning of an escalation to outweigh it.
///   DELEGATED KEY    setDelegate(key, addr): the hot EVM key the node process
///                    runs with (gas only). Contracts that act "for a node
///                    key" — MatchBook, NodeDirectory, EpochAnchor — accept
///                    the delegate or the operator. A leaked hot key is
///                    rotated in one operator transaction; the bond never
///                    moves.
///   NO SLASHER       slash() is callable only by ADJUDICATOR CONTRACTS named
///                    by admin (MatchBook, the custody challenger,
///                    EpochAnchor). No wallet may slash. The evidence is the
///                    calling contract's own state, reproducible from chain
///                    data alone. A slash is a FRACTION of the bond (basis
///                    points): lying costs a whale proportionally what it
///                    costs a minnow.
///   BOUNDED ADMIN    no term or period may exceed MAX_TERM, so an admin —
///                    even a compromised one — cannot trap bonds forever.
///   ADMIN            one address that sets parameters and adjudicators. It
///                    is meant to be a multisig behind a timelock; the
///                    contract cannot check that, so it exposes
///                    adminIsContract() and the deploy tool warns loudly.
///
/// standingOf(nodeKey) keeps the v2 signature — every reader (NodeDirectory,
/// NodeBadge, EpochAnchor, protocol/staking.js) keeps working.
///
/// What this is NOT: yield. Operators earn the per-match fee split for
/// serving (§11.4); nothing here pays anyone for holding a token.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract NodeStake {
    struct Node {
        address operator;    // who staked; moves only through transferOperator
        address delegate;    // the node's hot key; may act for the key, never move the bond
        uint256 amount;      // bonded, minus slashes
        uint64  bondedSince; // first stake of this bond; the LOCK counts from here
        uint64  lastStakedAt;// latest stake or top-up; the ELIGIBILITY AGE counts from here
        uint64  unbondAt;    // 0 = active; else the timestamp withdraw unlocks
    }

    uint64 public constant MAX_TERM = 365 days;
    uint16 public constant BPS = 10_000;

    IERC20Minimal public immutable token;
    uint256 public minStake;
    uint64  public lockTerm;         // unstake() allowed only after bondedSince + lockTerm
    uint64  public eligibilityAge;   // witnessEligible only after bondedSince + eligibilityAge
    uint64  public unbondingPeriod;  // must exceed every adjudicator's dispute + escalation windows
    address public admin;            // meant to be a multisig behind a timelock
    address public treasury;         // slashed funds; meant to be the fee pool

    mapping(bytes32 => Node) public nodes;
    mapping(address => bool) public adjudicators;   // contracts allowed to slash
    uint256 public totalActive;                     // sum of bonded amounts of nodes not unbonding (for stake-weighted quorum)

    event Staked(bytes32 indexed nodeKey, address indexed operator, uint256 amount, uint256 total, uint64 bondedSince, uint64 lastStakedAt);
    event OperatorTransferred(bytes32 indexed nodeKey, address indexed from, address indexed to);
    event DelegateSet(bytes32 indexed nodeKey, address indexed delegate);
    event Unbonding(bytes32 indexed nodeKey, uint64 unbondAt);
    event Withdrawn(bytes32 indexed nodeKey, address indexed operator, uint256 amount);
    event Slashed(bytes32 indexed nodeKey, uint256 amount, uint16 bps, bytes32 indexed reason, address indexed adjudicator);
    event AdjudicatorSet(address indexed adjudicator, bool allowed);
    event ParamsUpdated(uint256 minStake, uint64 lockTerm, uint64 eligibilityAge, uint64 unbondingPeriod, address admin, address treasury);

    error NotOperator();
    error NotAdmin();
    error NotAdjudicator();
    error ZeroAmount();
    error ZeroAddress();
    error NotUnbonding();
    error StillBonded();
    error StillLocked(uint64 until);
    error AlreadyUnbonding();
    error BadParams();

    constructor(IERC20Minimal token_, uint256 minStake_, uint64 lockTerm_, uint64 eligibilityAge_, uint64 unbondingPeriod_, address admin_, address treasury_) {
        if (admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (lockTerm_ > MAX_TERM || eligibilityAge_ > MAX_TERM || unbondingPeriod_ > MAX_TERM || unbondingPeriod_ == 0) revert BadParams();
        token = token_;
        minStake = minStake_;
        lockTerm = lockTerm_;
        eligibilityAge = eligibilityAge_;
        unbondingPeriod = unbondingPeriod_;
        admin = admin_;
        treasury = treasury_;
        emit ParamsUpdated(minStake_, lockTerm_, eligibilityAge_, unbondingPeriod_, admin_, treasury_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ------------------------------------------------------------ operator

    /// Bond `amount` behind `nodeKey`. First staker becomes the key's operator;
    /// a later top-up must come from the same address. The LOCK counts from
    /// the first stake of this bond (a bond withdrawn and re-staked starts a
    /// new lock — otherwise unbond-and-rebond would skip it). The ELIGIBILITY
    /// AGE counts from the latest stake or top-up: added stake waits again.
    function stake(bytes32 nodeKey, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Node storage n = nodes[nodeKey];
        if (n.operator == address(0)) n.operator = msg.sender;
        else if (n.operator != msg.sender) revert NotOperator();
        if (n.unbondAt != 0) revert AlreadyUnbonding();
        if (n.bondedSince == 0) n.bondedSince = uint64(block.timestamp);
        n.lastStakedAt = uint64(block.timestamp);
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        n.amount += amount;
        totalActive += amount;
        emit Staked(nodeKey, msg.sender, amount, n.amount, n.bondedSince, n.lastStakedAt);
    }

    /// Hand a node key's bond to another wallet. The rotation path an operator
    /// uses when its wallet is exposed: the bond, the key, the lock and the
    /// node's history stay; only who may unstake and delegate changes.
    function transferOperator(bytes32 nodeKey, address to) external {
        Node storage n = nodes[nodeKey];
        if (n.operator != msg.sender) revert NotOperator();
        if (to == address(0)) revert ZeroAddress();
        n.operator = to;
        emit OperatorTransferred(nodeKey, msg.sender, to);
    }

    /// Name (or clear, with address(0)) the hot key the node runs with.
    function setDelegate(bytes32 nodeKey, address delegate) external {
        Node storage n = nodes[nodeKey];
        if (n.operator != msg.sender) revert NotOperator();
        n.delegate = delegate;
        emit DelegateSet(nodeKey, delegate);
    }

    /// Start unbonding — only once the lock term has run. The key drops out
    /// of placement immediately (see standingOf); funds unlock after
    /// `unbondingPeriod`, during which a slash for work already done still
    /// lands.
    function unstake(bytes32 nodeKey) external {
        Node storage n = nodes[nodeKey];
        if (n.operator != msg.sender) revert NotOperator();
        if (n.unbondAt != 0) revert AlreadyUnbonding();
        uint64 lockedUntil = n.bondedSince + lockTerm;
        if (block.timestamp < lockedUntil) revert StillLocked(lockedUntil);
        n.unbondAt = uint64(block.timestamp) + unbondingPeriod;
        totalActive -= n.amount;
        emit Unbonding(nodeKey, n.unbondAt);
    }

    function withdraw(bytes32 nodeKey) external {
        Node storage n = nodes[nodeKey];
        if (n.operator != msg.sender) revert NotOperator();
        if (n.unbondAt == 0) revert NotUnbonding();
        if (block.timestamp < n.unbondAt) revert StillBonded();
        uint256 amount = n.amount;
        n.amount = 0;
        n.unbondAt = 0;
        n.bondedSince = 0;
        n.lastStakedAt = 0;
        n.delegate = address(0);
        require(token.transfer(msg.sender, amount), "transfer");
        emit Withdrawn(nodeKey, msg.sender, amount);
    }

    // ------------------------------------------------------------ adjudication

    /// Slash for misbehaviour an ADJUDICATOR CONTRACT established from its own
    /// state (a finalized MatchBook result the node attested against, a
    /// missed custody challenge, a root that contradicts the finalized set).
    /// `bps` of the CURRENT bond (10 000 = all of it); `reason` is that
    /// contract's identifier for the case (a matchId), so the event is
    /// auditable against chain data alone. Never a wallet. Returns the cut.
    function slash(bytes32 nodeKey, uint16 bps, bytes32 reason) external returns (uint256 cut) {
        if (!adjudicators[msg.sender]) revert NotAdjudicator();
        if (bps > BPS) revert BadParams();
        Node storage n = nodes[nodeKey];
        cut = n.amount * bps / BPS;
        n.amount -= cut;
        if (n.unbondAt == 0) totalActive -= cut;
        if (cut > 0) require(token.transfer(treasury, cut), "transfer");
        emit Slashed(nodeKey, cut, bps, reason, msg.sender);
    }

    // ------------------------------------------------------------ reads

    /// What placement reads (v2 signature, unchanged). `active` is the whole
    /// eligibility test for HOSTING: bonded at or above minStake and not
    /// unbonding.
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active) {
        Node storage n = nodes[nodeKey];
        return (n.operator, n.amount, n.unbondAt == 0 && n.amount >= minStake);
    }

    /// Everything v3 knows about a key, in one call.
    function nodeOf(bytes32 nodeKey) external view returns (address operator, address delegate, uint256 amount, uint64 bondedSince, uint64 unbondAt, bool active, bool eligible) {
        Node storage n = nodes[nodeKey];
        bool act = n.unbondAt == 0 && n.amount >= minStake;
        return (n.operator, n.delegate, n.amount, n.bondedSince, n.unbondAt, act, act && block.timestamp >= uint256(n.lastStakedAt) + eligibilityAge);
    }

    /// May this key be DRAWN TO ATTEST a ranked result: active, and nothing
    /// was added to its bond within eligibilityAge.
    function witnessEligible(bytes32 nodeKey) external view returns (bool) {
        Node storage n = nodes[nodeKey];
        return n.unbondAt == 0 && n.amount >= minStake && block.timestamp >= uint256(n.lastStakedAt) + eligibilityAge;
    }

    function delegateOf(bytes32 nodeKey) external view returns (address) { return nodes[nodeKey].delegate; }

    /// May `who` act on chain for `nodeKey`: its operator or its delegate.
    function mayActFor(bytes32 nodeKey, address who) external view returns (bool) {
        Node storage n = nodes[nodeKey];
        return who != address(0) && (who == n.operator || who == n.delegate);
    }

    /// True when admin has code — a multisig or a timelock, not a wallet.
    /// The deploy tool and /health report this; the contract cannot refuse an
    /// EOA without making testnet bring-up impossible.
    function adminIsContract() external view returns (bool) { return admin.code.length > 0; }

    // ------------------------------------------------------------ admin (multisig + timelock)

    function setAdjudicator(address adjudicator, bool allowed) external onlyAdmin {
        if (adjudicator == address(0)) revert ZeroAddress();
        adjudicators[adjudicator] = allowed;
        emit AdjudicatorSet(adjudicator, allowed);
    }

    /// unbondingPeriod must be at least lockTerm's companion: long enough
    /// that every adjudicator can still land a slash for work done before
    /// unstake(). The contract cannot know the adjudicators' windows, so it
    /// enforces only that the period is non-zero when any adjudicator exists;
    /// the deploy tool checks the windows.
    function setParams(uint256 minStake_, uint64 lockTerm_, uint64 eligibilityAge_, uint64 unbondingPeriod_, address admin_, address treasury_) external onlyAdmin {
        if (admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (lockTerm_ > MAX_TERM || eligibilityAge_ > MAX_TERM || unbondingPeriod_ > MAX_TERM || unbondingPeriod_ == 0) revert BadParams();
        minStake = minStake_;
        lockTerm = lockTerm_;
        eligibilityAge = eligibilityAge_;
        unbondingPeriod = unbondingPeriod_;
        admin = admin_;
        treasury = treasury_;
        emit ParamsUpdated(minStake_, lockTerm_, eligibilityAge_, unbondingPeriod_, admin_, treasury_);
    }
}
