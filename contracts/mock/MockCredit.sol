//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ICredit, CalendarUnit} from "../credit/interfaces/ICredit.sol";

contract MockCredit is ICredit {
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving, // whether repeated borrowing is allowed
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external {}

    function closeCredit(bytes32 creditHash) external {}

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external {}

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {}

    function updateYield(address borrower, uint yieldInBps) external {}

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery)
    {}

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {}

    function pauseCredit(bytes32 creditHash) external {}

    function unpauseCredit(bytes32 creditHash) external {}
}
