// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {ReceivableInput} from "../CreditStructs.sol";
import {CreditRecord} from "../CreditStructs.sol";

interface IReceivableCredit {
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

    function refreshCredit(uint256 receivableId) external;

    function triggerDefault(uint256 receivableId) external returns (uint256 losses);

    function closeCredit(uint256 receivableId) external;

    function pauseCredit(uint256 receivableId) external;

    function unpauseCredit(uint256 receivableId) external;

    function updateYield(uint256 receivableId, uint256 yieldInBps) external;
}
