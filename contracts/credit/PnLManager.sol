// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PnLTracker} from "./CreditStructs.sol";

contract PnLManager {
    PnLTracker pnlTracker;

    function processDrawdown() external {}

    function processPayback() external {}

    function processDefault() external {}

    function processRecovery() external {}

    function processDueUpdate(uint96 missedProfit, uint96 profitRateDiff) external {
        pnlTracker.totalProfit += missedProfit;
        pnlTracker.profitRate += profitRateDiff;
    }
}
