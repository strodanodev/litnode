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
///
/// Generation 4 (audit 2026-10-21 §4.2 finding 2): announce() requires the
/// key to be ACTIVE with at least NodeStake.minStake() bonded — v3 needed
/// only operator standing, so one wei of stake bought a permanent slot in
/// an append-only list every reader walks. Readers page through the list
/// with keysPage(offset, limit) + count() instead of one unbounded keys().
interface INodeStakeReader {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
    function minStake() external view returns (uint256);
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
    error NotBonded();

    constructor(INodeStakeReader stake_) { stake = stake_; }

    /// The operator delegates announcing for one node key. Zero address revokes.
    function setAnnouncer(bytes32 nodeKey, address announcer) external {
        (address op, , ) = stake.standingOf(nodeKey);
        if (op != msg.sender) revert NotOperator();
        announcerOf[nodeKey] = announcer;
        emit AnnouncerSet(nodeKey, announcer);
    }

    /// Publish the current addresses. `wsAddr` may be empty. The key must be
    /// actively bonded at or above minStake (generation 4).
    function announce(bytes32 nodeKey, string calldata url, string calldata wsAddr) external {
        (address op, uint256 amount, bool active) = stake.standingOf(nodeKey);
        if (msg.sender != op && msg.sender != announcerOf[nodeKey]) revert NotAllowed();
        if (!active || amount < stake.minStake()) revert NotBonded();
        if (bytes(url).length < 8 || bytes(url).length > 200 || bytes(wsAddr).length > 200) revert BadUrl();
        _entries[nodeKey] = Entry(url, wsAddr, uint64(block.timestamp), msg.sender);
        if (!_listed[nodeKey]) { _listed[nodeKey] = true; _keys.push(nodeKey); }
        emit Announced(nodeKey, url, wsAddr, msg.sender);
    }

    function entryOf(bytes32 nodeKey) external view returns (string memory url, string memory wsAddr, uint64 updatedAt, address announcer) {
        Entry storage e = _entries[nodeKey];
        return (e.url, e.wsAddr, e.updatedAt, e.announcer);
    }

    /// Generation tag: 4. A generation-3 NodeDirectory has no version() and reverts.
    function version() external pure returns (uint16) { return 4; }

    /// Keys [offset, offset + limit) in announce order; shorter (or empty)
    /// past the end. Readers walk it with count() and filter by
    /// NodeStake.active and updatedAt themselves — the list is append-only.
    function keysPage(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 n = _keys.length;
        if (offset >= n) return new bytes32[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _keys[i];
    }
    function count() external view returns (uint256) { return _keys.length; }

    /// Every key that ever announced, whole. KEPT FOR COMPATIBILITY ONLY:
    /// readers already in the field (sdk/bridge resolveNode in publishers'
    /// servers, tools/authority.mjs, node releases up to 0.11.x) call keys()
    /// on whatever NodeDirectory contracts.json names, and would lose
    /// discovery at the generation flip without it. New readers page with
    /// keysPage (protocol/directory.js readDirectoryKeys).
    function keys() external view returns (bytes32[] memory) { return _keys; }
}
