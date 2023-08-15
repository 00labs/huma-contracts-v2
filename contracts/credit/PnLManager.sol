// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PnLTracker} from "./CreditStructs.sol";

contract PnLManager {
    PnLTracker pnlTracker;

    function processDrawdown(uint96 poolIncome, uint96 profitRateDiff) external {
        pnlTracker.totalProfit += poolIncome;
        pnlTracker.profitRate += profitRateDiff;
    }

    function processPayback(uint96 principalPaid, uint96 feesPaid, uint16 yield) external {
        int96 profitRateDiff = -int96(
            uint96((principalPaid * yield) / HUNDRED_PERCENT_IN_BPS / SECONDS_IN_A_YEAR)
        );
        updateTracker(profitRateDiff, 0, uint96(feesPaid), 0, 0);
    }

    function processDefault() external {}

    function processRecovery() external {}

    function processDueUpdate(uint96 missedProfit, int96 profitRateDiff) external {
        updateTracker(profitRateDiff, 0, missedProfit, 0, 0);
    }

    function updateTracker(
        int96 profitRateDiff,
        int96 lossRateDiff,
        uint96 feesDiff,
        uint96 lossDiff,
        uint96 recoveryDiff
    ) internal {
        PnLTracker memory _tempTracker = pnlTracker;
        uint256 timeLapsed = block.timestamp - _tempTracker.pnlLastUpdated;
        _tempTracker.totalProfit += (feesDiff + uint96(_tempTracker.profitRate * timeLapsed));
        _tempTracker.totalLoss += (lossDiff + uint96(_tempTracker.lossRate * timeLapsed));
        _tempTracker.profitRate = uint96(int96(_tempTracker.profitRate) + profitRateDiff);
        _tempTracker.lossRate = uint96(int96(_tempTracker.lossRate) + lossRateDiff);
        _tempTracker.totalLossRecovery += recoveryDiff;
        pnlTracker = _tempTracker;
    }
}
