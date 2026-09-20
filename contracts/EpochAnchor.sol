// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EpochAnchor v3 — one FINALIZED root per hour, by STAKE-WEIGHTED
/// quorum of bonded nodes, proposed from their delegated keys.
/// @notice BUILD-SPEC v0.3 §11.6. v1 let any address write the first root;
/// v2 fixed that with a count of distinct operators, which a single entity
/// funding N stakes could manufacture, and required the operator's cold
/// key in a shell. v3:
///
///   - a node key's DELEGATE or operator may propose (NodeStake v3
///     `mayActFor`); the node proposes by itself after the hour freezes;
///   - support is the sum of the proposing nodes' BONDED AMOUNTS; a root
///     finalizes when its support reaches `quorumBps` of `totalActive`
///     (the active bonded stake of the whole network at that moment);
///     the first root to get there wins and nothing after that changes it;
///   - a node key proposes once per epoch; keys under one operator each
///     count with their own bond (they are separate locked stakes);
///   - the root is over the hour's FINALIZED MatchBook set (protocol/
///     matchbook.js chainEpoch), so every node holding the log computes the
///     same root and quorum is reachable without any two nodes talking;
///   - `quorumBps`, the stake contract and `admin` are set by `admin`
///     (a multisig behind a timelock).
///
/// What a finalized root proves: that nodes holding that share of the
/// network's stake committed to the same batch. An inclusion proof then
/// shows a leaf is in that batch; the leaf carries the match's on-chain
/// status, so "included" and "finalized" are both readable.
///
/// Tree convention (must match protocol/epoch.js exactly): leaves sorted
/// and deduplicated as lowercase hex strings, hashed pairwise as
/// sha256(hexA ‖ hexB) over the ASCII hex, an odd last node paired with
/// itself. verifyInclusion reproduces that here.
interface INodeStakeV3Reader {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
    function mayActFor(bytes32 nodeKey, address who) external view returns (bool);
    function totalActive() external view returns (uint256);
}

contract EpochAnchor {
    struct Anchor { bytes32 root; uint64 finalizedAt; uint256 support; uint256 totalActive; }

    INodeStakeV3Reader public stake;
    address public admin;
    uint16 public quorumBps;   // of totalActive; 10 000 = every bonded token
    uint16 public constant BPS = 10_000;

    mapping(uint64 => Anchor) public anchors;                                  // finalized only
    mapping(uint64 => mapping(bytes32 => uint256)) public support;            // epoch → root → bonded stake behind it
    mapping(uint64 => mapping(bytes32 => bytes32)) public proposalOf;         // epoch → nodeKey → root

    event Proposed(uint64 indexed epoch, bytes32 indexed root, bytes32 indexed nodeKey, address sender, uint256 weight, uint256 support, uint256 needed);
    event EpochFinalized(uint64 indexed epoch, bytes32 root, uint256 support, uint256 totalActive);
    event ParamsUpdated(address stake, uint16 quorumBps, address admin);

    error NotAdmin();
    error NotAllowed();
    error NotBonded();
    error AlreadyProposed(uint64 epoch, bytes32 root);
    error AlreadyFinalized(uint64 epoch, bytes32 root);
    error ZeroRoot();
    error BadParams();

    constructor(INodeStakeV3Reader stake_, uint16 quorumBps_, address admin_) {
        if (address(stake_) == address(0) || admin_ == address(0) || quorumBps_ == 0 || quorumBps_ > BPS) revert BadParams();
        stake = stake_; quorumBps = quorumBps_; admin = admin_;
        emit ParamsUpdated(address(stake_), quorumBps_, admin_);
    }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }

    function setParams(INodeStakeV3Reader stake_, uint16 quorumBps_, address admin_) external onlyAdmin {
        if (address(stake_) == address(0) || admin_ == address(0) || quorumBps_ == 0 || quorumBps_ > BPS) revert BadParams();
        stake = stake_; quorumBps = quorumBps_; admin = admin_;
        emit ParamsUpdated(address(stake_), quorumBps_, admin_);
    }

    /// Propose `root` for `epoch` for bonded node `nodeKey`, from its delegate or operator.
    function propose(uint64 epoch, bytes32 root, bytes32 nodeKey) external {
        if (root == bytes32(0)) revert ZeroRoot();
        if (!stake.mayActFor(nodeKey, msg.sender)) revert NotAllowed();
        (, uint256 amount, bool active) = stake.standingOf(nodeKey);
        if (!active) revert NotBonded();
        Anchor storage a = anchors[epoch];
        if (a.root != bytes32(0)) revert AlreadyFinalized(epoch, a.root);
        if (proposalOf[epoch][nodeKey] != bytes32(0)) revert AlreadyProposed(epoch, proposalOf[epoch][nodeKey]);
        proposalOf[epoch][nodeKey] = root;
        uint256 s = support[epoch][root] + amount;
        support[epoch][root] = s;
        uint256 total = stake.totalActive();
        uint256 needed = (total * quorumBps + BPS - 1) / BPS;
        emit Proposed(epoch, root, nodeKey, msg.sender, amount, s, needed);
        if (s >= needed && total > 0) {
            anchors[epoch] = Anchor(root, uint64(block.timestamp), s, total);
            emit EpochFinalized(epoch, root, s, total);
        }
    }

    /// The finalized root, or zero while the epoch is open or contested.
    function rootOf(uint64 epoch) external view returns (bytes32) { return anchors[epoch].root; }
    /// What a root for `epoch` needs right now, and what it has.
    function standing(uint64 epoch, bytes32 root) external view returns (uint256 has, uint256 needed, bool finalized) {
        uint256 total = stake.totalActive();
        return (support[epoch][root], (total * quorumBps + BPS - 1) / BPS, anchors[epoch].root == root && root != bytes32(0));
    }

    /// @param leaf   the leaf hash (bytes32)
    /// @param path   sibling hashes from leaf to root
    /// @param left   for each step, true if the sibling is on the LEFT
    function verifyInclusion(uint64 epoch, bytes32 leaf, bytes32[] calldata path, bool[] calldata left) external view returns (bool) {
        require(path.length == left.length, "path/left length");
        bytes32 cur = leaf;
        for (uint256 i = 0; i < path.length; i++) cur = left[i] ? _pair(path[i], cur) : _pair(cur, path[i]);
        return cur == anchors[epoch].root && cur != bytes32(0);
    }

    /// sha256 over the concatenated lowercase-hex ASCII of both nodes.
    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) { return sha256(abi.encodePacked(_hex(a), _hex(b))); }
    function _hex(bytes32 v) internal pure returns (bytes memory out) {
        bytes16 alphabet = 0x30313233343536373839616263646566; // "0123456789abcdef"
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) { out[2 * i] = alphabet[uint8(v[i] >> 4)]; out[2 * i + 1] = alphabet[uint8(v[i] & 0x0f)]; }
    }
    function adminIsContract() external view returns (bool) { return admin.code.length > 0; }
}
