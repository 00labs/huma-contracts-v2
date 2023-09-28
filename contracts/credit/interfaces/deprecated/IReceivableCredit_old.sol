// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, ReceivableInfo} from "../../CreditStructs.sol";

//* Reserved for Richard review, to be deleted
// Delete this interface because new IReceivableCredit is used

interface IReceivableCredit_old {
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

    function approveReceivable(address borrower, uint256 receivableId) external;

    function rejectReceivable(address borrower, uint256 receivableId) external;

    function drawdownWithReceivable(
        address borrower,
        address receivableAddress,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external;
}
