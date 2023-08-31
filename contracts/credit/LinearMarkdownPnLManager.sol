// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";

contract LinearMarkdownPnLManager is IPnLManager {
    PoolConfig internal _poolConfig;

    PnLTracker pnlTracker;
    mapping(bytes32 => CreditLoss) internal _creditLossMap;

    function processDrawdown(uint96 poolIncome, uint96 profitRateDiff) external {
        // todo access control
        updateTracker(int96(uint96(profitRateDiff)), 0, poolIncome, 0, 0);
    }

    function processPayback(
        bytes32 creditHash,
        uint96 principalPaid,
        uint96 yieldPaid,
        uint96 feesPaid,
        uint16 yield,
        bool oldGoodStanding,
        bool newGoodStanding
    ) external {
        // todo access control
        int96 profitRateDiff = -int96(
            uint96((principalPaid * yield) / HUNDRED_PERCENT_IN_BPS / SECONDS_IN_A_YEAR)
        );
        if (oldGoodStanding) {
            updateTracker(profitRateDiff, 0, uint96(feesPaid), 0, 0);
        } else {
            // handle recovery.
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            creditLoss.totalAccruedLoss += uint96(
                (block.timestamp - creditLoss.lastLossUpdateDate) * creditLoss.lossRate
            );
            creditLoss.lastLossUpdateDate = uint64(block.timestamp);

            uint96 lossRecovery;
            int96 lossRateDiff;
            if (newGoodStanding) {
                // recover all markdown for this user
                lossRecovery = creditLoss.totalAccruedLoss - creditLoss.totalLossRecovery;
                creditLoss.totalLossRecovery = creditLoss.totalAccruedLoss;
                lossRateDiff = int96(0 - creditLoss.lossRate);
            } else {
                // only recover the amount paid
                lossRecovery = principalPaid + yieldPaid;
                creditLoss.totalLossRecovery += uint96(lossRecovery);
            }

            // note todo need to think if the lossRate for both global and this individual creditRecord
            // be updated due to principalPaid.

            _creditLossMap[creditHash] = creditLoss;

            updateTracker(profitRateDiff, lossRateDiff, feesPaid, 0, lossRecovery);
        }
    }

    function processDefault(
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external {
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
        PnLTracker memory t = pnlTracker;
        updateTracker(int96(0 - t.profitRate), int96(0 - t.lossRate), 0, 0, 0);
    }

    function processDueUpdate(
        uint96 principalDiff,
        uint96 missedProfit,
        bool lateFlag,
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external {
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
    ) public returns (uint256 totalProfit, uint256 totalLoss, uint256 totalLossRecovery) {
        PnLTracker memory t = pnlTracker;
        uint256 timeLapsed = block.timestamp - t.pnlLastUpdated;
        t.totalProfit += (profitDiff + uint96(t.profitRate * timeLapsed));
        t.totalLoss += (lossDiff + uint96(t.lossRate * timeLapsed));
        t.profitRate = uint96(int96(t.profitRate) + profitRateDiff);
        t.lossRate = uint96(int96(t.lossRate) + lossRateDiff);
        t.totalLossRecovery += recoveryDiff;
        t.pnlLastUpdated = uint64(block.timestamp);
        pnlTracker = t;
        return (uint256(t.totalProfit), uint256(t.totalLoss), uint256(t.totalLossRecovery));
    }

    function getLastUpdated() external view returns (uint256 lastUpdated) {
        return pnlTracker.pnlLastUpdated;
    }

    /**
     * @notice
     */
    function refreshPnL()
        external
        virtual
        override
        returns (uint256 totalProfit, uint256 totalLoss, uint256 totalLossRecovery)
    {
        return updateTracker(0, 0, 0, 0, 0);
    }

    function getPnL()
        external
        view
        virtual
        override
        returns (
            uint96 totalProfit,
            uint96 totalLoss,
            uint96 totalLossRecovery,
            uint96 profitRate,
            uint96 lossRate,
            uint64 pnlLastUpdated
        )
    {
        PnLTracker memory _t = pnlTracker;
        return (
            _t.totalProfit,
            _t.totalLoss,
            _t.totalLossRecovery,
            _t.profitRate,
            _t.lossRate,
            _t.pnlLastUpdated
        );
    }

    function getPnLSum()
        external
        view
        virtual
        override
        returns (uint256 totalProfit, uint256 totalLoss, uint256 totalLossRecovery)
    {
        PnLTracker memory _t = pnlTracker;
        return (uint256(_t.totalProfit), uint256(_t.totalLoss), uint256(_t.totalLossRecovery));
    }
}
