// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {IPool} from "../../liquidity/interfaces/IPool.sol";
import {PoolConfig, PoolConfigCache} from "../PoolConfigCache.sol";

contract MockPoolCreditManager is PoolConfigCache {
    IPool public pool;

    function approveCredit(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) external {}

    function mockDistributeLoss(uint256 loss) external {
        pool.distributeLoss(loss);
    }

    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        address addr = poolConfig_.pool();
        assert(addr != address(0));
        pool = IPool(addr);
    }
}
