// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "../PoolConfig.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";

/**
 * @dev A child contract of PoolConfigCache that exposes internal functions for testing.
 */
contract MockPoolConfigCache is PoolConfigCache {
    /**
     * @dev Exposes the _initialize function for testing.
     */
    function otherInitialize(PoolConfig poolConfig_) external {
        _initialize(poolConfig_);
    }

    /**
     * @dev Overrides the _updatePoolConfigData function to make
     * abstract contract PoolConfigCache non-abstract.
     */
    function _updatePoolConfigData(PoolConfig poolConfig_) internal view override {
        address addr = poolConfig_.poolSafe();
        assert(addr != address(0));
    }
}
