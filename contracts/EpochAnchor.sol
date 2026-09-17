// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EpochAnchor v2 — one FINALIZED root per hour, by quorum of bonded operators.
/// @notice BUILD-SPEC v0.2 §11, repaired after the build audit. v1 let any
/// address write the first root for any epoch, so an early garbage root
/// could occupy an hour forever. v2:
///
///   - only the OPERATOR of an actively bonded node key may propose
///     (`NodeStake.standingOf(nodeKey).operator == msg.sender && active`);
///   - a root FINALIZES when `quorum` distinct operators have proposed the
///     same root for that epoch; conflicting proposals coexist and are
///     visible (`support(epoch, root)`), the first to reach quorum wins,
///     nothing after that changes it;
///   - an operator proposes once per epoch — a second proposal by the same
///     operator is refused, so one operator cannot manufacture a quorum;
///   - `quorum` and the stake contract are set by `admin`; testnet quorum
///     is 2 (two independent operators must agree).
///
/// What a finalized root proves: that `quorum` bonded operators committed
/// to the same batch. An inclusion proof then shows a leaf is in that
/// batch. Whether the leaf's match was VERIFIED (players signed, an
/// independent witness agreed) is recorded IN the leaf by the node
/// (protocol/epoch.js: `verified`), so a reader distinguishes "included"
/// from "verified" without trusting any one operator.
///
/// Tree convention (must match protocol/epoch.js exactly): leaves sorted
/// and deduplicated as lowercase hex strings, hashed pairwise as
/// sha256(hexA ‖ hexB) over the ASCII hex, an odd last node paired with
/// itself. verifyInclusion reproduces that here.
interface INodeStakeReader {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
}

contract EpochAnchor {
    struct Anchor { bytes32 root; uint64 finalizedAt; uint32 proposals; }

    INodeStakeReader public stake;
    address public admin;
    uint32 public quorum;

    mapping(uint64 => Anchor) public anchors;                                  // finalized only
    mapping(uint64 => mapping(bytes32 => uint32)) public support;             // epoch → root → distinct operators
    mapping(uint64 => mapping(address => bytes32)) public proposalOf;         // epoch → operator → root

    event Proposed(uint64 indexed epoch, bytes32 indexed root, address indexed operator, bytes32 nodeKey, uint32 support);
    event EpochFinalized(uint64 indexed epoch, bytes32 root, uint32 support);
    event ParamsUpdated(address stake, uint32 quorum, address admin);

    error NotAdmin();
    error NotBondedOperator();
    error AlreadyProposed(uint64 epoch, bytes32 root);
    error AlreadyFinalized(uint64 epoch, bytes32 root);
    error ZeroRoot();

    constructor(INodeStakeReader stake_, uint32 quorum_, address admin_) {
        stake = stake_;
        quorum = quorum_ == 0 ? 1 : quorum_;
        admin = admin_;
        emit ParamsUpdated(address(stake_), quorum, admin_);
    }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }

    function setParams(INodeStakeReader stake_, uint32 quorum_, address admin_) external onlyAdmin {
        stake = stake_;
        quorum = quorum_ == 0 ? 1 : quorum_;
        admin = admin_;
        emit ParamsUpdated(address(stake_), quorum, admin_);
    }

    /// Propose `root` for `epoch` as the operator of bonded node `nodeKey`.
    function propose(uint64 epoch, bytes32 root, bytes32 nodeKey) external {
        if (root == bytes32(0)) revert ZeroRoot();
        (address op, , bool active) = stake.standingOf(nodeKey);
        if (!active || op != msg.sender) revert NotBondedOperator();
        Anchor storage a = anchors[epoch];
        if (a.root != bytes32(0)) revert AlreadyFinalized(epoch, a.root);
        if (proposalOf[epoch][msg.sender] != bytes32(0)) revert AlreadyProposed(epoch, proposalOf[epoch][msg.sender]);
        proposalOf[epoch][msg.sender] = root;
        uint32 n = ++support[epoch][root];
        emit Proposed(epoch, root, msg.sender, nodeKey, n);
        if (n >= quorum) {
            anchors[epoch] = Anchor(root, uint64(block.timestamp), n);
            emit EpochFinalized(epoch, root, n);
        }
    }

    /// The finalized root, or zero while the epoch is open or contested.
    function rootOf(uint64 epoch) external view returns (bytes32) {
        return anchors[epoch].root;
    }

    /// @param leaf   the leaf hash (bytes32)
    /// @param path   sibling hashes from leaf to root
    /// @param left   for each step, true if the sibling is on the LEFT
    function verifyInclusion(uint64 epoch, bytes32 leaf, bytes32[] calldata path, bool[] calldata left)
        external view returns (bool)
    {
        require(path.length == left.length, "path/left length");
        bytes32 cur = leaf;
        for (uint256 i = 0; i < path.length; i++) {
            cur = left[i] ? _pair(path[i], cur) : _pair(cur, path[i]);
        }
        return cur == anchors[epoch].root && cur != bytes32(0);
    }

    /// sha256 over the concatenated lowercase-hex ASCII of both nodes.
    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(_hex(a), _hex(b)));
    }

    function _hex(bytes32 v) internal pure returns (bytes memory out) {
        bytes16 alphabet = 0x30313233343536373839616263646566; // "0123456789abcdef"
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            out[2 * i] = alphabet[uint8(v[i] >> 4)];
            out[2 * i + 1] = alphabet[uint8(v[i] & 0x0f)];
        }
    }
}
