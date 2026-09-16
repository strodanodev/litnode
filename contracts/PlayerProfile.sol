// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title PlayerProfile — the litVM Games profile: one soulbound token per
/// wallet, any number of player keys bound to it.
/// @notice Deploy target: litVM Liteforge testnet, chain 4441.
///
/// The wallet AUTHORIZES a key; the key SIGNS play; this contract says which
/// wallet a key belongs to; a node READS that with eth_call — the same shape
/// as NodeStake.standingOf for operators (docs/WALLET-IDENTITY.md).
///
/// A player key is the browser's ed25519 public key (32 bytes) as bytes32.
/// The contract cannot verify an ed25519 signature and does not try: binding
/// proves the wallet CLAIMS the key. A wallet that binds a key it does not
/// hold earns nothing by it and paid gas for it; first-come, like any registry.
///
/// Soulbound: no transfer, no approval. A ladder position that can be sold is
/// not a ladder position, and a transfer mid-epoch would move settled deltas
/// between owners after the fact. Move devices with bindKey/revokeKey.
contract PlayerProfile {
    string public constant name = "litVM Games Profile";
    string public constant symbol = "LITP";

    struct Binding { uint256 tokenId; bool active; }

    uint256 public nextId = 1;
    mapping(uint256 => address) private _ownerOf;      // tokenId → wallet
    mapping(address => uint256) public profileOf;      // wallet → tokenId, 0 = none
    mapping(uint256 => string) public nameOf;
    mapping(bytes32 => Binding) private _bindings;     // playerKey → its profile, ever
    mapping(uint256 => bytes32[]) private _keysOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId); // ERC-721 mint only
    event KeyBound(uint256 indexed tokenId, bytes32 indexed key);
    event KeyRevoked(uint256 indexed tokenId, bytes32 indexed key);
    event Renamed(uint256 indexed tokenId, string name);

    error AlreadyRegistered();
    error NoProfile();
    error KeyTaken();
    error NotYourKey();
    error BadName();
    error Soulbound();
    error NoSuchToken();

    /// One transaction: mint a profile to msg.sender and bind its first key.
    function register(bytes32 key, string calldata name_) external returns (uint256 tokenId) {
        if (profileOf[msg.sender] != 0) revert AlreadyRegistered();
        _checkName(name_);
        tokenId = nextId++;
        _ownerOf[tokenId] = msg.sender;
        profileOf[msg.sender] = tokenId;
        nameOf[tokenId] = name_;
        emit Transfer(address(0), msg.sender, tokenId);
        _bind(tokenId, key);
    }

    /// Add a device key to the caller's profile. A key this profile revoked
    /// earlier may be re-activated; a key bound to another profile may not.
    function bindKey(bytes32 key) external {
        uint256 t = profileOf[msg.sender];
        if (t == 0) revert NoProfile();
        _bind(t, key);
    }

    /// Stop accepting a key (a leaked browser). Nodes refuse its queue entries
    /// within a tick; its settled history stays with the profile.
    function revokeKey(bytes32 key) external {
        uint256 t = profileOf[msg.sender];
        if (t == 0) revert NoProfile();
        Binding storage b = _bindings[key];
        if (b.tokenId != t || !b.active) revert NotYourKey();
        b.active = false;
        emit KeyRevoked(t, key);
    }

    function rename(string calldata name_) external {
        uint256 t = profileOf[msg.sender];
        if (t == 0) revert NoProfile();
        _checkName(name_);
        nameOf[t] = name_;
        emit Renamed(t, name_);
    }

    // ------------------------------------------------------------ reads

    /// What a node reads for every player key it sees. tokenId 0 = never bound.
    function ownerOfKey(bytes32 key) external view returns (address owner, uint256 tokenId, bool active) {
        Binding storage b = _bindings[key];
        return (_ownerOf[b.tokenId], b.tokenId, b.active);
    }

    /// Every key ever bound to a profile, revoked ones included; check
    /// ownerOfKey(key).active for the current state.
    function keysOf(uint256 tokenId) external view returns (bytes32[] memory) {
        return _keysOf[tokenId];
    }

    // ------------------------------------------------------------ ERC-721, read side

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _ownerOf[tokenId];
        if (o == address(0)) revert NoSuchToken();
        return o;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return profileOf[owner] == 0 ? 0 : 1;
    }

    function totalSupply() external view returns (uint256) {
        return nextId - 1;
    }

    /// Inline metadata; no server to go dark. Names are restricted to
    /// [A-Za-z0-9 _.-] so the JSON needs no escaping.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return string.concat(
            'data:application/json,{"name":"', nameOf[tokenId],
            '","description":"litVM Games profile #', _uint(tokenId),
            ' - a soulbound player identity on litVM. Keys bound: ', _uint(_keysOf[tokenId].length),
            '","attributes":[{"trait_type":"keys","value":', _uint(_keysOf[tokenId].length), '}]}'
        );
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x5b5e139f || id == 0x01ffc9a7; // ERC-721, ERC-721Metadata, ERC-165
    }

    // ------------------------------------------------------------ ERC-721, write side: none

    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }
    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    // ------------------------------------------------------------ internals

    function _bind(uint256 tokenId, bytes32 key) internal {
        Binding storage b = _bindings[key];
        if (b.tokenId == 0) {
            b.tokenId = tokenId;
            _keysOf[tokenId].push(key);
        } else if (b.tokenId != tokenId) {
            revert KeyTaken();
        }
        b.active = true;
        emit KeyBound(tokenId, key);
    }

    function _checkName(string calldata s) internal pure {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > 32) revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x5f || c == 0x2e || c == 0x2d;
            if (!ok) revert BadName();
        }
    }

    function _uint(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory out = new bytes(len);
        while (v != 0) { out[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(out);
    }
}
