// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "../CreditStructs.sol";
import {ICredit} from "./ICredit.sol";

interface IDynamicYieldCredit is ICredit {
    function getEstimatedYield() external;
    function declareYield() external;
}
