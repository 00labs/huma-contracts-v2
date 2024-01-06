// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IReceivableFactoringCreditForContract {
    function makePaymentWithReceivableByPayer(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);
}
