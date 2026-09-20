// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title ReleaseRegistry — which litnode builds a node may run, and from when.
/// @notice BUILD-SPEC v0.3 §2.4. A release is still signed by the release key
/// (node/update.js); this contract adds the second lock: the release zip's
/// sha256 must be REGISTERED here by `admin` (a multisig behind a timelock)
/// and be ACTIVE — `activatesAt` at least `activationDelay` after
/// registration — before any node applies it. One leaked release key can no
/// longer ship code to every node within the hour; anyone watching this
/// contract has the delay to read the diff. A bad release is `revoke`d at
/// once — pulling code needs no delay.
///
/// Keyed by the zip hash, not the version string: a version is a label, the
/// bytes are what runs.
contract ReleaseRegistry {
    struct Release {
        string  version;
        bytes32 protocol;     // the protocol version the build speaks, as bytes32(uint)
        uint64  registeredAt;
        uint64  activatesAt;
        bool    revoked;
    }

    address public admin;
    uint64  public activationDelay;   // seconds between register() and the earliest activatesAt

    mapping(bytes32 => Release) public releases;   // zipHash → release
    bytes32[] private _hashes;

    event Registered(bytes32 indexed zipHash, string version, bytes32 protocol, uint64 activatesAt);
    event Revoked(bytes32 indexed zipHash, string version);
    event ParamsUpdated(address admin, uint64 activationDelay);

    error NotAdmin();
    error ZeroAddress();
    error AlreadyRegistered(bytes32 zipHash);
    error Unknown(bytes32 zipHash);
    error TooSoon(uint64 earliest);

    constructor(address admin_, uint64 activationDelay_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        activationDelay = activationDelay_;
        emit ParamsUpdated(admin_, activationDelay_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// Register a build. `activatesAt` may be later than the minimum (a
    /// scheduled rollout) but never earlier.
    function register(bytes32 zipHash, string calldata version, bytes32 protocol, uint64 activatesAt) external onlyAdmin {
        if (releases[zipHash].registeredAt != 0) revert AlreadyRegistered(zipHash);
        uint64 earliest = uint64(block.timestamp) + activationDelay;
        if (activatesAt < earliest) revert TooSoon(earliest);
        releases[zipHash] = Release(version, protocol, uint64(block.timestamp), activatesAt, false);
        _hashes.push(zipHash);
        emit Registered(zipHash, version, protocol, activatesAt);
    }

    /// Pull a build. Immediate. A node refuses to apply a revoked release and
    /// a node already running it reports `revoked` on /health.
    function revoke(bytes32 zipHash) external onlyAdmin {
        Release storage r = releases[zipHash];
        if (r.registeredAt == 0) revert Unknown(zipHash);
        r.revoked = true;
        emit Revoked(zipHash, r.version);
    }

    /// What a node asks before applying: is this zip registered, active now,
    /// and not revoked.
    function statusOf(bytes32 zipHash) external view returns (bool registered, bool active, bool revoked, string memory version, uint64 activatesAt) {
        Release storage r = releases[zipHash];
        bool reg = r.registeredAt != 0;
        return (reg, reg && !r.revoked && block.timestamp >= r.activatesAt, r.revoked, r.version, r.activatesAt);
    }

    function hashes() external view returns (bytes32[] memory) { return _hashes; }
    function count() external view returns (uint256) { return _hashes.length; }
    function adminIsContract() external view returns (bool) { return admin.code.length > 0; }

    function setParams(address admin_, uint64 activationDelay_) external onlyAdmin {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        activationDelay = activationDelay_;
        emit ParamsUpdated(admin_, activationDelay_);
    }
}
