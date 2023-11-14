// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableInput} from "../CreditStructs.sol";
import {CreditConfig, CreditRecord} from "../CreditStructs.sol";

interface IOldReceivableCredit {
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount
    ) external;

    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external;

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function getCreditConfig(uint256 receivableId) external view returns (CreditConfig memory);

    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory);
}
