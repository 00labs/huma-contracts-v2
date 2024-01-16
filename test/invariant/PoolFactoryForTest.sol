// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolConfig} from "contracts/common/PoolConfig.sol";

contract PoolFactoryForTest is PoolFactory {
    function addPoolOwner(uint256 _poolId, address poolOwner) public {
        _onlyDeployer(msg.sender);

        PoolFactory.PoolRecord memory poolRecord = this.checkPool(_poolId);
        PoolConfig poolConfig = PoolConfig(poolRecord.poolConfigAddress);
        poolConfig.grantRole(poolConfig.DEFAULT_ADMIN_ROLE(), poolOwner);
        poolConfig.renounceRole(poolConfig.DEFAULT_ADMIN_ROLE(), address(this));
    }
}
