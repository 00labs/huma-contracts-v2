// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolSafe} from "../../liquidity/interfaces/IPoolSafe.sol";
import {IPool} from "../../liquidity/interfaces/IPool.sol";
import {PoolConfig, PoolConfigCache} from "../PoolConfigCache.sol";
import {Errors} from "../Errors.sol";

contract MockPoolCredit is PoolConfigCache {
    IPoolSafe public poolSafe;
    IPool public pool;

    uint256 public profit_;
    uint256 public loss_;
    uint256 public lossRecovery_;

    function approveCredit(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) external {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.underlyingToken();
        assert(addr != address(0));
        IERC20(addr).approve(address(poolSafe), type(uint256).max);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external {
        poolSafe.withdraw(address(this), borrowAmount);
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolSafe.deposit(address(this), amount);
    }

    function mockDistributePnL(uint256 profit, uint256 loss, uint256 lossRecovery) external {
        pool.distributeProfit(profit);
        pool.distributeLoss(loss);
        pool.distributeLossRecovery(lossRecovery);
    }
}