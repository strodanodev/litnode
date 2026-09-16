// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title NodeStake — the bond an operator posts to host a node.
/// @notice Deploy target: litVM Liteforge testnet, chain 4441. Stakes the
/// LITVM token (a testnet mock until the real token exists on Liteforge).
///
/// What this is: a registration gate and a slashable bond. A node key that is
/// not staked at or above `minStake` is not eligible for placement, and a
/// witness must sit under a different staking address than the host. Both
/// facts are read from this contract, so they are no longer self-asserted in
/// a heartbeat (BUILD-SPEC §16, "operator and standing are self-asserted").
///
/// What this is NOT: yield. The whitepaper (§5.4) says operators earn for
/// serving ticks, not for holding a token; nothing here pays anyone for
/// staking. The bond exists so that misbehaviour has a cost.
///
/// Node key: the node's ed25519 public key (32 bytes) as bytes32. The node
/// proves possession by signing every heartbeat with it; the contract binds
/// that key to the operator address that staked for it.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract NodeStake {
    struct Node {
        address operator;   // who staked; never changes for a key
        uint256 amount;     // bonded, minus slashes
        uint64 unbondAt;    // 0 = active; else the timestamp withdraw unlocks
    }

    IERC20Minimal public immutable token;
    uint256 public minStake;
    uint64 public unbondingPeriod;
    /// Testnet: a single slasher (the attestation authority). Mainnet: the
    /// agent + operator consensus the whitepaper describes (§3.3, §5.3).
    address public slasher;
    address public treasury;

    mapping(bytes32 => Node) public nodes;

    event Staked(bytes32 indexed nodeKey, address indexed operator, uint256 amount, uint256 total);
    event Unbonding(bytes32 indexed nodeKey, uint64 unbondAt);
    event Withdrawn(bytes32 indexed nodeKey, address indexed operator, uint256 amount);
    event Slashed(bytes32 indexed nodeKey, uint256 amount, bytes32 indexed reason);
    event ParamsUpdated(uint256 minStake, uint64 unbondingPeriod, address slasher, address treasury);

    error NotOperator();
    error NotSlasher();
    error ZeroAmount();
    error NotUnbonding();
    error StillBonded();
    error AlreadyUnbonding();

    constructor(IERC20Minimal token_, uint256 minStake_, uint64 unbondingPeriod_, address slasher_, address treasury_) {
        token = token_;
        minStake = minStake_;
        unbondingPeriod = unbondingPeriod_;
        slasher = slasher_;
        treasury = treasury_;
    }

    modifier onlySlasher() {
        if (msg.sender != slasher) revert NotSlasher();
        _;
    }

    /// Bond `amount` behind `nodeKey`. First staker becomes the key's operator;
    /// later top-ups must come from the same address.
    function stake(bytes32 nodeKey, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Node storage n = nodes[nodeKey];
        if (n.operator == address(0)) n.operator = msg.sender;
        else if (n.operator != msg.sender) revert NotOperator();
        if (n.unbondAt != 0) revert AlreadyUnbonding();
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        n.amount += amount;
        emit Staked(nodeKey, msg.sender, amount, n.amount);
    }

    /// Start unbonding. The key drops out of placement immediately (see
    /// standingOf); funds unlock after `unbondingPeriod`, during which a
    /// slash for work already done can still land.
    function unstake(bytes32 nodeKey) external {
        Node storage n = nodes[nodeKey];
        if (n.operator != msg.sender) revert NotOperator();
        if (n.unbondAt != 0) revert AlreadyUnbonding();
        n.unbondAt = uint64(block.timestamp) + unbondingPeriod;
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
        require(token.transfer(msg.sender, amount), "transfer");
        emit Withdrawn(nodeKey, msg.sender, amount);
    }

    /// Slash for attested misbehaviour (a bad root, a refused co-sign, a
    /// forged heartbeat). `reason` is the hash of the evidence bundle so the
    /// event is auditable against the delta set.
    function slash(bytes32 nodeKey, uint256 amount, bytes32 reason) external onlySlasher {
        Node storage n = nodes[nodeKey];
        uint256 cut = amount > n.amount ? n.amount : amount;
        n.amount -= cut;
        require(token.transfer(treasury, cut), "transfer");
        emit Slashed(nodeKey, cut, reason);
    }

    /// What placement reads. `active` is the whole eligibility test: bonded at
    /// or above minStake and not unbonding.
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active) {
        Node storage n = nodes[nodeKey];
        return (n.operator, n.amount, n.unbondAt == 0 && n.amount >= minStake);
    }

    function setParams(uint256 minStake_, uint64 unbondingPeriod_, address slasher_, address treasury_) external onlySlasher {
        minStake = minStake_;
        unbondingPeriod = unbondingPeriod_;
        slasher = slasher_;
        treasury = treasury_;
        emit ParamsUpdated(minStake_, unbondingPeriod_, slasher_, treasury_);
    }
}
