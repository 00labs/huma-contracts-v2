//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICredit, CalendarUnit} from "../credit/interfaces/ICredit.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {PoolConfig, PoolConfigCache} from "../PoolConfigCache.sol";
import {Errors} from "../Errors.sol";

contract MockCredit is PoolConfigCache, ICredit {
    IPoolVault public poolVault;

    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        IERC20(addr).approve(address(poolVault), type(uint256).max);
    }

    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        CalendarUnit calendarUnit, // days or semimonth
        uint16 periodDuration,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving, // whether repeated borrowing is allowed
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external {}

    function closeCredit(bytes32 creditHash) external {}

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external {
        poolVault.withdraw(address(this), borrowAmount);
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolVault.deposit(address(this), amount);
    }

    function updateYield(address borrower, uint yieldInBps) external {}

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery)
    {}

    function refreshPnL(
        bytes32 creditHash
    ) external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {}

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {}

    function pauseCredit() external {}

    function unpauseCredit() external {}
}
