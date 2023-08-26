// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditConfig, ReceivableInfo} from "../CreditStructs.sol";
import {CalendarUnit} from "../../SharedDefs.sol";

interface ICredit {
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving, // whether repeated borrowing is allowed
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external;

    // function approveCredit(
    //     address borrower,
    //     uint96 creditLimit,
    //     CalendarUnit calendarUnit, // days or semimonth
    //     uint16 periodDuration,
    //     uint16 numOfPeriods, // number of periods
    //     uint16 yieldInBps,
    //     uint96 committedAmount,
    //     bool revolving // whether repeated borrowing is allowed
    // ) external;

    function closeCredit(bytes32 creditHash) external;

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external;

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function updateYield(address borrower, uint yieldInBps) external;

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function refreshPnL(
        bytes32 creditHash
    ) external returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function pauseCredit() external;

    function unpauseCredit() external;
}
