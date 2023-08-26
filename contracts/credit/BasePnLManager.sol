// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";

/**
 * @notice BasePnLManager books profit only after it is paid and books loss as soon as the payment
 * is late. 
 */
contract BasePnLManager is IPnLManager {
    PoolConfig internal _poolConfig;

    PnLTracker pnlTracker;
    mapping(bytes32 => CreditLoss) internal _creditLossMap;

    function processDrawdown(uint96 poolIncome, uint96 profitRateDiff) external virtual override {
        // todo access control
        pnlTracker.totalProfit += poolIncome;
    }

    function processPayback(
        bytes32 creditHash,
        uint96 principalPaid,
        uint96 yieldPaid,
        uint96 feesPaid,
        uint16 yield,
        bool oldGoodStanding,
        bool newGoodStanding
    ) external virtual override {
        // todo access control
        if (oldGoodStanding) {
            updateTracker(0, 0, uint96(feesPaid + yieldPaid), 0, 0);
        } else {
            // handle recovery.
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            creditLoss.lastLossUpdateDate = uint64(block.timestamp);

            uint96 lossRecovery;
            if (newGoodStanding) {
                // recover all markdown for this user
                lossRecovery = creditLoss.totalAccruedLoss - creditLoss.totalLossRecovery;
                creditLoss.totalLossRecovery = creditLoss.totalAccruedLoss;
            } else {
                // only recover the amount paid
                lossRecovery = principalPaid + yieldPaid;
            }

            _creditLossMap[creditHash] = creditLoss;

            updateTracker(0, 0, feesPaid, 0, lossRecovery);
        }
    }

    function processDefault(
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external virtual override {
        CreditLoss memory tempCreditLoss = _creditLossMap[creditHash];
        uint256 cutoffDate = block.timestamp > tempCreditLoss.lossExpiringDate
            ? tempCreditLoss.lossExpiringDate
            : block.timestamp;
        tempCreditLoss.totalAccruedLoss += uint96(
            tempCreditLoss.lossRate * (cutoffDate - tempCreditLoss.lastLossUpdateDate)
        );
        tempCreditLoss.totalAccruedLoss += 0;
        tempCreditLoss.lossRate = 0;
        tempCreditLoss.lastLossUpdateDate = uint64(cutoffDate);
        _creditLossMap[creditHash] = tempCreditLoss;

        // Write off any remaining principal and dues. Stop profitRate and lossRate
        PnLTracker memory _tempTracker = pnlTracker;
        updateTracker(
            int96(0 - _tempTracker.profitRate),
            int96(0 - _tempTracker.lossRate),
            0,
            0,
            0
        );
    }

    function processDueUpdate(
        uint96 principalDiff,
        uint96 missedProfit,
        bool lateFlag,
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external virtual override {
        int96 markdownRateDiff = 0;
        uint96 markdown = 0;
        int96 profitRateDiff = int96(uint96((principalDiff * cc.yieldInBps) / SECONDS_IN_A_YEAR));

        if (lateFlag) {
            markdownRateDiff = _getMarkdownRate(cc, cr) + profitRateDiff;
            markdown = uint96(uint96(markdownRateDiff) * (block.timestamp - cr.nextDueDate));
        }
        updateTracker(profitRateDiff, markdownRateDiff, missedProfit, markdown, 0);

        // Need to maintain _creditLossMap
        CreditLoss memory tempCreditLoss = _creditLossMap[creditHash];
        tempCreditLoss.totalAccruedLoss += markdown;
        tempCreditLoss.lossRate = uint96(markdownRateDiff);
        tempCreditLoss.lastLossUpdateDate = uint64(block.timestamp);
        _creditLossMap[creditHash] = tempCreditLoss;
    }

    function getPrincipal(CreditRecord memory cr) internal pure returns (uint96 principal) {
        principal = cr.unbilledPrincipal + cr.totalDue - cr.feesDue - cr.yieldDue;
    }

    function _getMarkdownRate(
        CreditConfig memory cc,
        CreditRecord memory cr
    ) internal view returns (int96 markdownRate) {
        uint16 gracePeriodInCU = _poolConfig.getPoolSettings().defaultGracePeriodInCalendarUnit;
        uint256 gracePeriod = gracePeriodInCU * SECONDS_IN_A_DAY;
        if (cc.calendarUnit == CalendarUnit.Month) gracePeriod *= 30;
        markdownRate = int96(uint96(getPrincipal(cr) / gracePeriod));
    }

    function updateTracker(
        int96 profitRateDiff,
        int96 lossRateDiff,
        uint96 profitDiff,
        uint96 lossDiff,
        uint96 recoveryDiff
    ) public virtual override {
        PnLTracker memory _tempTracker = pnlTracker;
        uint256 timeLapsed = block.timestamp - _tempTracker.pnlLastUpdated;
        _tempTracker.totalProfit += (profitDiff + uint96(_tempTracker.profitRate * timeLapsed));
        _tempTracker.totalLoss += (lossDiff + uint96(_tempTracker.lossRate * timeLapsed));
        _tempTracker.profitRate = uint96(int96(_tempTracker.profitRate) + profitRateDiff);
        _tempTracker.lossRate = uint96(int96(_tempTracker.lossRate) + lossRateDiff);
        _tempTracker.totalLossRecovery += recoveryDiff;
        _tempTracker.pnlLastUpdated = uint64(block.timestamp);
        pnlTracker = _tempTracker;
    }

    function getLastUpdated() external view returns (uint256 lastUpdated) {
        return pnlTracker.pnlLastUpdated;
    }
}
