// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, ReceivableInfo, FacilityConfig, ReceivableState} from "./CreditStructs.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {IReceivableCredit} from "./interfaces/IReceivableCredit.sol";
import {Receivable} from "./Receivable.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import {ReceivableCredit} from "./ReceivableCredit.sol";

/**
 * ReceivableCredit is a credit backed by receivables.
 */
contract ReceivableFactoringCredit is ReceivableCredit {
    

}
