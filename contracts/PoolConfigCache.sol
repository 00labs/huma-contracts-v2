// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCacheUpgradeable} from "./PoolConfigCacheUpgradeable.sol";
import {Errors} from "./Errors.sol";

/**
 * @notice All contracts addresses and configurations of pool level are stored in PoolConfig contract.
 * Any pool level contract needs to inherit PoolConfigCache or PoolConfigCacheUpgradeable.
 * PoolConfigCacheUpgradeable/PoolConfigCache is responsible for managing PoolConfig and
 * caching the addresses of depended contracts. PoolConfigCache is for non-upgradeable contracts.
 */

abstract contract PoolConfigCache is PoolConfigCacheUpgradeable {
    /**
     * @param poolConfigAddress The address of the pool config contract,
     * it is mandatory because of updatePoolConfigData's permission control.
     */
    constructor(address poolConfigAddress) {
        if (poolConfigAddress == address(0)) revert Errors.zeroAddressProvided();
        poolConfig = PoolConfig(poolConfigAddress);
    }
}
