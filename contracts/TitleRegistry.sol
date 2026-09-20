// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title TitleRegistry — who publishes a title, and which builds of it may run.
/// @notice A title is an ERC-721 token; its holder is the publisher. One
/// token per `rulesetId` (tokenId = keccak256(rulesetId)). Minting it is
/// registration, first come. There is no admin, no signer list, no rotate
/// function: a studio is an EOA or a multisig, and a hand-over is a
/// transfer. Whatever holds the token decides which build hashes are the
/// title's builds.
///
/// The builds: a node loads a build from a PEER only when this contract
/// says the build is registered under its title and ACTIVE — the same lock
/// ReleaseRegistry puts on litnode releases. The first build activates at
/// once (a new title has no players to protect); every later build waits
/// `activationDelay`, so a retune is visible before it settles anything.
/// A build is `revoke`d at once. Old deltas stay replayable in the build
/// they settled with — revocation stops loading, not history.
///
/// Listing is not here. The arcade lists a registered title only while a
/// bonded node whose operator IS the token holder hosts it (litnode
/// /titles.published): a publisher runs a host or is not listed. That is a
/// mesh fact the node checks; the chain only says who owns what.
contract TitleRegistry {
    struct Build { uint64 registeredAt; uint64 activatesAt; bool revoked; }
    struct Title { string rulesetId; uint64 registeredAt; bytes32[] builds; }

    string public constant name = "litVM Games Title";
    string public constant symbol = "TITLE";
    uint64 public immutable activationDelay;

    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operator;
    mapping(uint256 => Title) private _title;
    mapping(uint256 => mapping(bytes32 => Build)) private _build;
    uint256 public totalSupply;

    // ERC-721
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    // registry
    event Registered(uint256 indexed titleId, string rulesetId, address indexed publisher, bytes32 indexed buildHash);
    event BuildSet(uint256 indexed titleId, bytes32 indexed buildHash, uint64 activatesAt);
    event BuildRevoked(uint256 indexed titleId, bytes32 indexed buildHash);

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error AlreadyRegistered(uint256 titleId);
    error UnknownTitle(uint256 titleId);
    error UnknownBuild(bytes32 buildHash);
    error BuildExists(bytes32 buildHash);
    error TooSoon(uint64 earliest);
    error BadRulesetId();
    error UnsafeRecipient();

    constructor(uint64 activationDelay_) { activationDelay = activationDelay_; }

    // ------------------------------------------------------------ ids
    /// The token id of a rulesetId — pure, so any client can compute it.
    function titleIdOf(string calldata rulesetId) external pure returns (uint256) { return uint256(keccak256(bytes(rulesetId))); }

    // ------------------------------------------------------------ registration
    /// Claim `rulesetId` for msg.sender with its first build, active now.
    function register(string calldata rulesetId, bytes32 buildHash) external returns (uint256 titleId) {
        bytes memory id = bytes(rulesetId);
        if (id.length == 0 || id.length > 64) revert BadRulesetId();
        titleId = uint256(keccak256(id));
        if (_owner[titleId] != address(0)) revert AlreadyRegistered(titleId);
        if (buildHash == bytes32(0)) revert UnknownBuild(buildHash);
        _owner[titleId] = msg.sender;
        _balance[msg.sender] += 1;
        totalSupply += 1;
        Title storage t = _title[titleId];
        t.rulesetId = rulesetId;
        t.registeredAt = uint64(block.timestamp);
        t.builds.push(buildHash);
        _build[titleId][buildHash] = Build(uint64(block.timestamp), uint64(block.timestamp), false);
        emit Transfer(address(0), msg.sender, titleId);
        emit Registered(titleId, rulesetId, msg.sender, buildHash);
        emit BuildSet(titleId, buildHash, uint64(block.timestamp));
    }

    /// Add a build to a title you hold. `activatesAt` may be later than the
    /// minimum (a scheduled rollout), never earlier. 0 = the earliest allowed.
    function setBuild(uint256 titleId, bytes32 buildHash, uint64 activatesAt) external {
        if (_owner[titleId] != msg.sender) revert NotOwner();
        if (buildHash == bytes32(0)) revert UnknownBuild(buildHash);
        if (_build[titleId][buildHash].registeredAt != 0) revert BuildExists(buildHash);
        uint64 earliest = uint64(block.timestamp) + activationDelay;
        if (activatesAt == 0) activatesAt = earliest;
        if (activatesAt < earliest) revert TooSoon(earliest);
        _title[titleId].builds.push(buildHash);
        _build[titleId][buildHash] = Build(uint64(block.timestamp), activatesAt, false);
        emit BuildSet(titleId, buildHash, activatesAt);
    }

    /// Pull a build. Immediate: no node loads it from a peer from now on.
    function revokeBuild(uint256 titleId, bytes32 buildHash) external {
        if (_owner[titleId] != msg.sender) revert NotOwner();
        Build storage b = _build[titleId][buildHash];
        if (b.registeredAt == 0) revert UnknownBuild(buildHash);
        b.revoked = true;
        emit BuildRevoked(titleId, buildHash);
    }

    // ------------------------------------------------------------ reads
    /// What a node asks before loading a peer's build.
    function buildStatus(uint256 titleId, bytes32 buildHash) external view returns (address publisher, bool registered, bool active, bool revoked, uint64 activatesAt) {
        Build storage b = _build[titleId][buildHash];
        bool reg = b.registeredAt != 0;
        return (_owner[titleId], reg, reg && !b.revoked && block.timestamp >= b.activatesAt, b.revoked, b.activatesAt);
    }
    function titleOf(uint256 titleId) external view returns (address publisher, string memory rulesetId, uint64 registeredAt, uint256 buildCount) {
        Title storage t = _title[titleId];
        return (_owner[titleId], t.rulesetId, t.registeredAt, t.builds.length);
    }
    function buildsOf(uint256 titleId) external view returns (bytes32[] memory) { return _title[titleId].builds; }

    // ------------------------------------------------------------ ERC-721
    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owner[tokenId];
        if (o == address(0)) revert UnknownTitle(tokenId);
        return o;
    }
    function balanceOf(address who) external view returns (uint256) { if (who == address(0)) revert ZeroAddress(); return _balance[who]; }
    function getApproved(uint256 tokenId) external view returns (address) { ownerOf(tokenId); return _approved[tokenId]; }
    function isApprovedForAll(address owner, address operator) external view returns (bool) { return _operator[owner][operator]; }
    function tokenURI(uint256 tokenId) external view returns (string memory) { ownerOf(tokenId); return string.concat("litvm-title:", _title[tokenId].rulesetId); }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !_operator[o][msg.sender]) revert NotAuthorized();
        _approved[tokenId] = to;
        emit Approval(o, to, tokenId);
    }
    function setApprovalForAll(address operator, bool on) external { _operator[msg.sender][operator] = on; emit ApprovalForAll(msg.sender, operator, on); }

    /// The hand-over. Whoever receives the token is the publisher from this
    /// block: the right to set and revoke builds moves with it, nothing else changes.
    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        if (o != from) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != o && msg.sender != _approved[tokenId] && !_operator[o][msg.sender]) revert NotAuthorized();
        delete _approved[tokenId];
        _balance[from] -= 1;
        _balance[to] += 1;
        _owner[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
    function safeTransferFrom(address from, address to, uint256 tokenId) external { safeTransferFrom(from, to, tokenId, ""); }
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            (bool ok, bytes memory ret) = to.call(abi.encodeWithSelector(0x150b7a02, msg.sender, from, tokenId, data));
            if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != bytes4(0x150b7a02)) revert UnsafeRecipient();
        }
    }
}
