// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @notice All contract addresses and configurations at the pool level are stored in the PoolConfig contract.
 * All pool level contracts need to inherit PoolConfigCache.
 * PoolConfigCache is responsible for managing PoolConfig and caching the addresses of depending contracts.
 */
abstract contract PoolConfigCache is Initializable, UUPSUpgradeable {
    PoolConfig public poolConfig;

    /**
     * @notice The pool config cache has changed.
     * @param poolConfig The address of the PoolConfig contract based on which the cache is updated.
     */
    event PoolConfigCacheUpdated(address indexed poolConfig);

    /**
     * @notice The pool config cache has changed.
     * @param newPoolConfig The address of the new PoolConfig contract.
     * @param oldPoolConfig The address of the old PoolConfig contract.
     */
    event PoolConfigChanged(address indexed newPoolConfig, address indexed oldPoolConfig);

    constructor() {
        _disableInitializers();
    }

    function initialize(PoolConfig _poolConfig) external virtual initializer {
        _initialize(_poolConfig);
        __UUPSUpgradeable_init();
    }

    /**
     * @notice This function should be called immediately to cache depending contract addresses after the contract is deployed.
     * @custom:access Only the pool owner can call this function.
     */
    function updatePoolConfigData() external {
        poolConfig.onlyPoolOwner(msg.sender);
        _updatePoolConfigData(poolConfig);
        emit PoolConfigCacheUpdated(address(poolConfig));
    }

    /**
     * @notice Sets new pool config contract address.
     * @param _poolConfig The address of the new pool config contract.
     * @custom:access Only the pool owner of the old pool config contract can call this function.
     */
    function setPoolConfig(PoolConfig _poolConfig) external {
        if (address(_poolConfig) == address(0)) revert Errors.ZeroAddressProvided();
        PoolConfig oldPoolConfig = poolConfig;
        oldPoolConfig.onlyPoolOwner(msg.sender);
        poolConfig = _poolConfig;
        _updatePoolConfigData(_poolConfig);
        emit PoolConfigChanged(address(_poolConfig), address(oldPoolConfig));
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual;

    function _initialize(PoolConfig _poolConfig) internal onlyInitializing {
        if (address(_poolConfig) == address(0)) revert Errors.ZeroAddressProvided();
        poolConfig = _poolConfig;
        _updatePoolConfigData(_poolConfig);
    }

    function _authorizeUpgrade(address) internal view override {
        poolConfig.onlyHumaOwner(msg.sender);
    }
}
