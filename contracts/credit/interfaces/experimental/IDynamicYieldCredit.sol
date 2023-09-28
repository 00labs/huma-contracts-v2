// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "../../CreditStructs.sol";
import {ICredit} from "../deprecated/ICredit.sol";

//* Reserved for Richard review, to be deleted
// This is not in V2 scope

interface IDynamicYieldCredit is ICredit {
    function getEstimatedYield() external;

    function declareYield() external;
}
