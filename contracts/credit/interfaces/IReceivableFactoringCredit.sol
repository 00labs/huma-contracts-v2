// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableInput} from "../CreditStructs.sol";
import {CreditRecord} from "../CreditStructs.sol";

interface IReceivableFactoringCredit {
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

    function getReceivableCreditRecord(
        uint256 receivableId
    ) external view returns (CreditRecord memory);
}
