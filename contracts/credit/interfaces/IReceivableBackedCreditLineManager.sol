// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

import {ReceivableInput} from "../CreditStructs.sol";

interface IReceivableBackedCreditLineManager {
    function approveReceivable(address borrower, ReceivableInput memory receivableInput) external;

    function validateReceivable(address borrower, uint256 receivableId) external view;

    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external;
}
