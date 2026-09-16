// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EpochAnchor — one root per hour, from any bonded settler.
/// @notice BUILD-SPEC v0.2 §11. The node prepares `anchorEpoch(uint64,bytes32)`
/// calldata (selector 0xbc978154) and the operator broadcasts it. Anyone can
/// later prove one match's leaf against the anchored root with the sha256
/// binary path `protocol/epoch.js` produces.
///
/// Tree convention (must match protocol/epoch.js exactly):
///   leaves sorted and deduplicated as lowercase hex strings, then hashed
///   pairwise as sha256(hexA ‖ hexB) over the ASCII hex — NOT over raw bytes —
///   with an odd last node paired with itself. verifyInclusion reproduces
///   that here, so an off-chain proof and an on-chain check agree.
///
/// Who may anchor: on testnet, anyone (the first root per epoch wins). On
/// mainnet this is gated on the NodeStake bond and disagreement is resolved
/// by the wider witness set — neither is implemented, and this contract
/// says so rather than pretending.
contract EpochAnchor {
    struct Anchor { bytes32 root; address settler; uint64 anchoredAt; }

    mapping(uint64 => Anchor) public anchors;

    event EpochAnchored(uint64 indexed epoch, bytes32 root, address indexed settler);

    error AlreadyAnchored(uint64 epoch, bytes32 existing);

    function anchorEpoch(uint64 epoch, bytes32 root) external {
        Anchor storage a = anchors[epoch];
        if (a.root != bytes32(0)) revert AlreadyAnchored(epoch, a.root);
        anchors[epoch] = Anchor(root, msg.sender, uint64(block.timestamp));
        emit EpochAnchored(epoch, root, msg.sender);
    }

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
