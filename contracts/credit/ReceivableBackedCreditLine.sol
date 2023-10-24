// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableCredit} from "./ReceivableCredit.sol";
import {BorrowerLevelCreditConfig} from "./BorrowerLevelCreditConfig.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {CreditConfig, CreditRecord} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

contract ReceivableBackedCreditLine is BorrowerLevelCreditConfig, ReceivableCredit {}
