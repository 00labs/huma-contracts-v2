// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolSafe} from "../../liquidity/interfaces/IPoolSafe.sol";
import {IPool} from "../../liquidity/interfaces/IPool.sol";
import {PoolConfig, PoolConfigCache} from "../PoolConfigCache.sol";

contract MockPoolCredit is PoolConfigCache {
    IPoolSafe public poolSafe;
    IPool public pool;

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external {
        poolSafe.withdraw(address(this), borrowAmount);
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolSafe.deposit(address(this), amount);
    }

    function mockDistributeProfit(uint256 profit) external {
        pool.distributeProfit(profit);
    }

    function mockDistributeLossRecovery(uint256 lossRecovery) external {
        pool.distributeLossRecovery(lossRecovery);
    }

    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        address addr = poolConfig_.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = poolConfig_.underlyingToken();
        assert(addr != address(0));
        IERC20(addr).approve(address(poolSafe), type(uint256).max);

        addr = poolConfig_.pool();
        assert(addr != address(0));
        pool = IPool(addr);
    }
}
