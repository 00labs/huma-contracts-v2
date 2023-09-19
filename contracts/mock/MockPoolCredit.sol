//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolCredit} from "../credit/interfaces/IPoolCredit.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {PoolConfig, PoolConfigCache} from "../PoolConfigCache.sol";
import {Errors} from "../Errors.sol";
import {CreditRecord, CreditConfig} from "../credit/CreditStructs.sol";

contract MockPoolCredit is PoolConfigCache, IPoolCredit {
    IPoolVault public poolVault;

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
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        IERC20(addr).approve(address(poolVault), type(uint256).max);
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external {
        poolVault.withdraw(address(this), borrowAmount);
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolVault.deposit(address(this), amount);
    }

    function getAccruedPnL()
        external
        view
        returns (uint256 accruedProfit, uint256 accruedLoss, uint256 accruedLossRecovery)
    {}

    function setRefreshPnLReturns(uint256 _profit, uint256 _loss, uint256 _lossRecovery) external {
        profit_ = _profit;
        loss_ = _loss;
        lossRecovery_ = _lossRecovery;
    }

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {
        profit = profit_;
        loss = loss_;
        lossRecovery = lossRecovery_;
    }
}
