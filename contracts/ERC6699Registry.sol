// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ERC-6699 (proposed) — universal character rules and stats.
/// @notice Deploy target: litVM Liteforge testnet, chain 4441, EVM Shanghai.
/// Stats are fixed width so no title can quietly overflow another's balance,
/// and the soul is committed by hash so the document can live anywhere and
/// still be checked by anyone.
interface IERC6699 {
    struct CoreStats {
        uint16 strength;
        uint16 agility;
        uint16 resilience;
        uint16 intelligence;
        uint32 level;
        uint64 experience;
    }

    struct AgentManifest {
        string  characterConfigURI; // character.json
        bytes32 soulManifestHash;   // keccak256(SOUL.MD)
        address agentController;    // who may act for the agent
    }

    function coreStats(uint256 tokenId) external view returns (CoreStats memory);
    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory);
    function equipped(uint256 tokenId, bytes32 slot) external view returns (address collection, uint256 assetId);

    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId) external;
    function unequip(uint256 tokenId, bytes32 slot) external;

    event Equipped(uint256 indexed tokenId, bytes32 indexed slot, address collection, uint256 assetId);
    event ManifestUpdated(uint256 indexed tokenId, bytes32 soulManifestHash);
    event Attested(uint256 indexed tokenId, bytes32 indexed registryEntry);
}

contract ERC6699Registry is IERC6699 {
    mapping(uint256 => CoreStats) private _stats;
    mapping(uint256 => AgentManifest) private _manifest;
    mapping(uint256 => mapping(bytes32 => address)) private _slotCollection;
    mapping(uint256 => mapping(bytes32 => uint256)) private _slotAsset;
    mapping(uint256 => address) public ownerOf;

    error NotController();

    modifier onlyController(uint256 tokenId) {
        if (msg.sender != _manifest[tokenId].agentController && msg.sender != ownerOf[tokenId]) revert NotController();
        _;
    }

    function forge(uint256 tokenId, address owner, CoreStats calldata s, AgentManifest calldata m) external {
        require(ownerOf[tokenId] == address(0), "exists");
        ownerOf[tokenId] = owner;
        _stats[tokenId] = s;
        _manifest[tokenId] = m;
        emit ManifestUpdated(tokenId, m.soulManifestHash);
    }

    function coreStats(uint256 tokenId) external view returns (CoreStats memory) { return _stats[tokenId]; }
    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory) { return _manifest[tokenId]; }

    function equipped(uint256 tokenId, bytes32 slot) external view returns (address, uint256) {
        return (_slotCollection[tokenId][slot], _slotAsset[tokenId][slot]);
    }

    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId)
        external onlyController(tokenId)
    {
        _slotCollection[tokenId][slot] = collection;
        _slotAsset[tokenId][slot] = assetId;
        emit Equipped(tokenId, slot, collection, assetId);
    }

    function unequip(uint256 tokenId, bytes32 slot) external onlyController(tokenId) {
        delete _slotCollection[tokenId][slot];
        delete _slotAsset[tokenId][slot];
        emit Equipped(tokenId, slot, address(0), 0);
    }
}
