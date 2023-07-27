// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {BaseCredit} from "./BaseCredit.sol";

contract DynamicYieldCredit is BaseCredit {
    function getEstimatedYield() external {}

    function declareYield() public virtual returns (uint96 yield) {}
}
