// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {BasePnLManager} from "./BasePnLManager.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {ICredit} from "./interfaces/ICredit.sol";

contract LinearMarkdownPnLManager is BasePnLManager {
    constructor(address poolConfigAddress) BasePnLManager(poolConfigAddress) {}

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
}
