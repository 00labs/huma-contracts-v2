// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {BasePnLManager} from "./BasePnLManager.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {ICredit} from "./interfaces/ICredit.sol";

import "hardhat/console.sol";

contract LinearMarkdownPnLManager is BasePnLManager {
    function processDrawdown(uint96 poolIncome, uint96 profitRateDiff) external {
        onlyCreditContract();
        _updateTracker(int96(uint96(profitRateDiff)), 0, int96(poolIncome), 0, 0);
    }

    function processPayback(
        bytes32 creditHash,
        uint96 principalPaid,
        uint96 yieldPaid,
        int96 profitDiff,
        uint16 yield,
        bool oldGoodStanding,
        bool isFullyRecovered
    ) external {
        //* Reserved for Richard review, to be deleted, please review this function

        onlyCreditContract();
        int96 profitRateDiff = -int96(
            uint96(
                (principalPaid * yield * DEFAULT_DECIMALS_FACTOR) /
                    (HUNDRED_PERCENT_IN_BPS * SECONDS_IN_A_YEAR)
            )
        );
        if (oldGoodStanding) {
            _updateTracker(profitRateDiff, 0, profitDiff, 0, 0);
        } else {
            // Update credit loss
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            creditLoss.totalAccruedLoss += uint96(
                ((block.timestamp - creditLoss.lastLossUpdateDate) * creditLoss.lossRate) /
                    DEFAULT_DECIMALS_FACTOR
            );
            creditLoss.totalAccruedLoss = uint96(int96(creditLoss.totalAccruedLoss) + profitDiff);
            creditLoss.lossRate = uint96(int96(creditLoss.lossRate) + profitRateDiff);
            creditLoss.lastLossUpdateDate = uint64(block.timestamp);

            //* Reserved for Richard review, to be deleted
            // It is more clear to update pnl tracker to the lastest value first, then handle recovery.

            // Update tracker till  now
            PnLTracker memory tracker = _getLatestTracker(
                profitRateDiff,
                profitRateDiff,
                profitDiff,
                profitDiff,
                0
            );

            // Handle receovery
            uint96 lossRecovery;
            if (isFullyRecovered) {
                // recover all markdown for this user
                lossRecovery = creditLoss.totalAccruedLoss - creditLoss.totalLossRecovery;
                tracker.accruedLossRecovery += lossRecovery;
                tracker.lossRate -= creditLoss.lossRate;
                delete _creditLossMap[creditHash];
            } else {
                // only recover the amount paid
                lossRecovery = principalPaid + yieldPaid;
                creditLoss.totalLossRecovery += uint96(lossRecovery);
                tracker.accruedLossRecovery += lossRecovery;
                _creditLossMap[creditHash] = creditLoss;
            }

            pnlTracker = tracker;

            //* Reserved for Richard review, to be deleted, the following is the old code for reference
            // note todo need to think if the lossRate for both global and this individual creditRecord
            // be updated due to principalPaid.

            // _updateTracker(profitRateDiff, lossRateDiff, profitDiff, 0, lossRecovery);
        }
    }

    function processDefault(
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external {
        //* Reserved for Richard review, to be deleted, please review this function

        onlyCreditContract();
        CreditLoss memory creditLoss = _creditLossMap[creditHash];

        PnLTracker memory tracker = _getLatestTracker(0, 0, 0, 0, 0);

        // console.log(
        //     "tracker.lossRate: %s, creditLoss.lossRate: %s",
        //     tracker.lossRate,
        //     creditLoss.lossRate
        // );

        //* Reserved for Richard review, to be deleted
        // Here may have accurancy issue, so need this check tracker.lossRate > creditLoss.lossRate

        // deduct loss rate
        tracker.lossRate = tracker.lossRate > creditLoss.lossRate
            ? tracker.lossRate - creditLoss.lossRate
            : 0;

        // deduct profit rate
        uint96 deductedProfitRate = uint96(
            (getPrincipal(cr) * cc.yieldInBps * DEFAULT_DECIMALS_FACTOR) /
                (HUNDRED_PERCENT_IN_BPS * SECONDS_IN_A_YEAR)
        );
        // console.log(
        //     "deductedProfitRate: %s, tracker.profitRate: %s",
        //     deductedProfitRate,
        //     tracker.profitRate
        // );

        //* Reserved for Richard review, to be deleted
        // Here may have accurancy issue, so need this check
        tracker.profitRate = tracker.profitRate > deductedProfitRate
            ? tracker.profitRate - deductedProfitRate
            : 0;

        // deduct overcalculated profit
        uint96 deductedProfit = uint96(
            (deductedProfitRate * (block.timestamp - creditLoss.lossExpiringDate)) /
                DEFAULT_DECIMALS_FACTOR
        );
        // console.log(
        //     "deductedProfit: %s, tracker.accruedProfit: %s",
        //     deductedProfit,
        //     tracker.accruedProfit
        // );

        //* Reserved for Richard review, to be deleted
        // Here may have accurancy issue, so need this check
        tracker.accruedProfit = tracker.accruedProfit > deductedProfit
            ? tracker.accruedProfit - deductedProfit
            : 0;

        // deduct overcalculated loss
        uint96 deductedLoss = uint96(
            (creditLoss.lossRate * (block.timestamp - creditLoss.lossExpiringDate)) /
                DEFAULT_DECIMALS_FACTOR
        );

        // console.log(
        //     "deductedLoss: %s, tracker.accruedLoss: %s",
        //     deductedLoss,
        //     tracker.accruedLoss
        // );

        //* Reserved for Richard review, to be deleted
        // Here may have accurancy issue, so need this check
        tracker.accruedLoss = tracker.accruedLoss > deductedLoss
            ? tracker.accruedLoss - deductedLoss
            : 0;

        pnlTracker = tracker;

        //* Reserved for Richard review, to be deleted
        // Here may have accurancy issue, so need this check
        creditLoss.totalAccruedLoss = creditLoss.totalAccruedLoss > deductedLoss
            ? creditLoss.totalAccruedLoss - deductedLoss
            : 0;
        creditLoss.lossRate = 0;
        creditLoss.lastLossUpdateDate = uint64(creditLoss.lossExpiringDate);
        _creditLossMap[creditHash] = creditLoss;
    }

    function processDueUpdate(
        uint96 principalDiff,
        uint96 missedProfit,
        uint96 lossImpact,
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external {
        //* Reserved for Richard review, to be deleted, please review this function
        // cr is the old due info when credit becomes late

        onlyCreditContract();
        int96 markdownRateDiff = 0;
        uint96 markdown = 0;
        int96 profitRateDiff = int96(
            uint96(
                (principalDiff * cc.yieldInBps * DEFAULT_DECIMALS_FACTOR) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            )
        );

        //* Reserved for Richard review, to be deleted
        // lossImpact has 2 effects
        // 1) it shows if the credit is late
        // 2) its value is the profit impact for the first time late
        if (lossImpact > 0) {
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            //* Reserved for Richard review, to be deleted
            // creditLoss.lastLossUpdateDate is used to determine if the credit is late for the first time
            if (creditLoss.lastLossUpdateDate == 0) {
                // process late first time
                console.log("process late first time - cr.nextDueDate: %s", cr.nextDueDate);
                (markdownRateDiff, creditLoss.lossExpiringDate) = _getMarkdownRate(cr);
                //* Reserved for Richard review, to be deleted
                // markdown has 2 parts, 1) the profit impact for the first time late, 2) the markdown for the time passed since the first time late
                markdown =
                    uint96(
                        (uint96(markdownRateDiff) * (block.timestamp - cr.nextDueDate)) /
                            DEFAULT_DECIMALS_FACTOR
                    ) +
                    lossImpact;
                console.log(
                    "markdown: %s, part1: %s, part2: %s",
                    uint256(markdown),
                    uint256(lossImpact),
                    uint256(
                        uint96(
                            (uint96(markdownRateDiff) * (block.timestamp - cr.nextDueDate)) /
                                DEFAULT_DECIMALS_FACTOR
                        )
                    )
                );
                markdownRateDiff += int96(
                    uint96(
                        ((principalDiff + getPrincipal(cr)) *
                            cc.yieldInBps *
                            DEFAULT_DECIMALS_FACTOR) / (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
                    )
                );

                creditLoss.totalAccruedLoss = markdown;
                creditLoss.lossRate = uint96(markdownRateDiff);
            } else {
                //* Reserved for Richard review, to be deleted
                // only add profit rate to loss rate, and add profit diff to loss diff after the first time late
                markdownRateDiff = profitRateDiff;
                markdown = missedProfit;

                creditLoss.totalAccruedLoss +=
                    markdown +
                    uint96(
                        ((block.timestamp - creditLoss.lastLossUpdateDate) * creditLoss.lossRate) /
                            DEFAULT_DECIMALS_FACTOR
                    );
                creditLoss.lossRate += uint96(markdownRateDiff);
            }
            creditLoss.lastLossUpdateDate = uint64(block.timestamp);
            _creditLossMap[creditHash] = creditLoss;
        }
        _updateTracker(profitRateDiff, markdownRateDiff, int96(missedProfit), int96(markdown), 0);
    }
}
