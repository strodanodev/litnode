// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title NodeDirectory — where a bonded node says how to reach it.
/// @notice The decentralized bootstrap list. A seed behind carrier-grade NAT
/// lives on an outbound tunnel whose hostname changes; it publishes the
/// current URL here and everyone — a fresh install typing no SEEDS, the
/// hosted arcade page, a peer that lost it — reads it back with eth_call.
///
/// Who may write: the node's OPERATOR (the wallet that bonded it on
/// NodeStake) or an ANNOUNCER address the operator delegated for that one
/// node key. The node holds only the announcer key, never the operator's
/// (BUILD-SPEC §11): a leaked announcer can misdirect one node's discovery
/// and nothing else, and readers verify the node's identity on arrival.
///
/// Readers ignore entries whose node is not actively bonded, so an
/// unbonded key cannot squat in the list.
interface INodeStakeReader {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
}

contract NodeDirectory {
    struct Entry { string url; string wsAddr; uint64 updatedAt; address announcer; }

    INodeStakeReader public immutable stake;
    mapping(bytes32 => Entry) private _entries;
    mapping(bytes32 => address) public announcerOf;
    bytes32[] private _keys;
    mapping(bytes32 => bool) private _listed;

    event AnnouncerSet(bytes32 indexed nodeKey, address indexed announcer);
    event Announced(bytes32 indexed nodeKey, string url, string wsAddr, address indexed by);

    error NotOperator();
    error NotAllowed();
    error BadUrl();

    constructor(INodeStakeReader stake_) { stake = stake_; }

    /// The operator delegates announcing for one node key. Zero address revokes.
    function setAnnouncer(bytes32 nodeKey, address announcer) external {
        (address op, , ) = stake.standingOf(nodeKey);
        if (op != msg.sender) revert NotOperator();
        announcerOf[nodeKey] = announcer;
        emit AnnouncerSet(nodeKey, announcer);
    }

    /// Publish the current addresses. `wsAddr` may be empty.
    function announce(bytes32 nodeKey, string calldata url, string calldata wsAddr) external {
        (address op, , ) = stake.standingOf(nodeKey);
        if (msg.sender != op && msg.sender != announcerOf[nodeKey]) revert NotAllowed();
        if (bytes(url).length < 8 || bytes(url).length > 200 || bytes(wsAddr).length > 200) revert BadUrl();
        _entries[nodeKey] = Entry(url, wsAddr, uint64(block.timestamp), msg.sender);
        if (!_listed[nodeKey]) { _listed[nodeKey] = true; _keys.push(nodeKey); }
        emit Announced(nodeKey, url, wsAddr, msg.sender);
    }

    function entryOf(bytes32 nodeKey) external view returns (string memory url, string memory wsAddr, uint64 updatedAt, address announcer) {
        Entry storage e = _entries[nodeKey];
        return (e.url, e.wsAddr, e.updatedAt, e.announcer);
    }

    /// Every key that ever announced. Readers filter by NodeStake.active and
    /// by updatedAt themselves — the list is append-only and cheap to read.
    function keys() external view returns (bytes32[] memory) { return _keys; }
    function count() external view returns (uint256) { return _keys.length; }
}
