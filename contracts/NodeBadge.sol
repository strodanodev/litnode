// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title NodeBadge — "litVM Games Node": a soulbound token an operator can
/// show for a node they have bonded. Only ever as true as the bond.
/// @notice Reads NodeStake.standingOf; changes nothing there. tokenId is the
/// node key itself, so a badge and the key it stands for are one number.
///
/// Not a reward. There is no rewards contract (BUILD-SPEC §16); the bond is
/// a cost of misbehaviour, not a yield (whitepaper §5.4). If a badge ever
/// carries value it is because the work it points at is verifiable in the
/// delta set, not because it was minted.
interface INodeStake {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
}

contract NodeBadge {
    string public constant name = "litVM Games Node";
    string public constant symbol = "LITN";

    INodeStake public immutable stake;
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Claimed(bytes32 indexed nodeKey, address indexed operator);
    event Revoked(bytes32 indexed nodeKey, address indexed operator);

    error NotBonded();
    error NotOperator();
    error AlreadyClaimed();
    error StillBonded();
    error Soulbound();
    error NoSuchToken();

    constructor(INodeStake stake_) { stake = stake_; }

    /// Mint the badge for a node key you have an active bond behind.
    function claim(bytes32 nodeKey) external {
        (address op, , bool active) = stake.standingOf(nodeKey);
        if (!active) revert NotBonded();
        if (op != msg.sender) revert NotOperator();
        uint256 id = uint256(nodeKey);
        if (_ownerOf[id] != address(0)) revert AlreadyClaimed();
        _ownerOf[id] = msg.sender;
        balanceOf[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, id);
        emit Claimed(nodeKey, msg.sender);
    }

    /// Anyone may burn a badge whose bond is no longer active. A badge that
    /// outlives its bond would be a claim the chain no longer backs.
    function sync(bytes32 nodeKey) external {
        uint256 id = uint256(nodeKey);
        address o = _ownerOf[id];
        if (o == address(0)) revert NoSuchToken();
        (, , bool active) = stake.standingOf(nodeKey);
        if (active) revert StillBonded();
        delete _ownerOf[id];
        balanceOf[o] -= 1;
        emit Transfer(o, address(0), id);
        emit Revoked(nodeKey, o);
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _ownerOf[tokenId];
        if (o == address(0)) revert NoSuchToken();
        return o;
    }

    /// Live: the badge reports the bond as it is now, not as it was minted.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address o = ownerOf(tokenId);
        (, uint256 amount, bool active) = stake.standingOf(bytes32(tokenId));
        return string.concat(
            'data:application/json,{"name":"litVM Games Node ', _hex(bytes32(tokenId), 6),
            '","description":"A bonded node on the litVM Games mesh. Node key ', _hex(bytes32(tokenId), 32),
            ', operator ', _hex(bytes32(uint256(uint160(o))), 32),
            '","attributes":[{"trait_type":"bonded","value":', active ? "true" : "false",
            '},{"trait_type":"bond_wei","value":"', _uint(amount), '"}]}'
        );
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x5b5e139f || id == 0x01ffc9a7;
    }

    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }
    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    function _hex(bytes32 v, uint256 nBytes) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + nBytes * 2);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < nBytes; i++) {
            uint8 b = uint8(v[32 - nBytes + i]);
            out[2 + i * 2] = alphabet[b >> 4];
            out[3 + i * 2] = alphabet[b & 0x0f];
        }
        return string(out);
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
