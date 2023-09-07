// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @notice All contracts addresses and configurations of pool level are stored in PoolConfig contract.
 * Any pool level contract needs to inherit PoolConfigCacheUpgradeable or PoolConfigCache.
 * PoolConfigCacheUpgradeable/PoolConfigCache is responsible for managing PoolConfig and
 * caching the addresses of depended contracts. PoolConfigCacheUpgradeable is for upgradeable contracts.
 */

abstract contract PoolConfigCache is Initializable {
    PoolConfig public poolConfig;

    event PoolConfigCacheUpdated(address indexed poolConfig);
    event PoolConfigChanged(address indexed newPoolConfig, address indexed oldPoolConfig);

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual;

    function initialize(PoolConfig _poolConfig) public virtual initializer {
        _initialize(_poolConfig);
    }

    function _initialize(PoolConfig _poolConfig) internal onlyInitializing {
        if (address(_poolConfig) == address(0)) revert Errors.zeroAddressProvided();
        poolConfig = _poolConfig;
        _updatePoolConfigData(_poolConfig);
    }

    /**
     * @notice It should be called immediately to cache depended contracts addresses after the contract is deployed.
     */
    function updatePoolConfigData() external {
        poolConfig.onlyPoolOwner(msg.sender);
        _updatePoolConfigData(poolConfig);
        emit PoolConfigCacheUpdated(address(poolConfig));
    }

    /**
     * @notice Set new pool config contract address. It requires pool owner permission in old pool config contract.
     * @param _poolConfig The address of the new pool config contract.
     */
    function setPoolConfig(PoolConfig _poolConfig) external {
        if (address(_poolConfig) == address(0)) revert Errors.zeroAddressProvided();
        PoolConfig oldPoolConfig = poolConfig;
        oldPoolConfig.onlyPoolOwner(msg.sender);
        poolConfig = _poolConfig;
        _updatePoolConfigData(_poolConfig);
        emit PoolConfigChanged(address(_poolConfig), address(oldPoolConfig));
    }
}
