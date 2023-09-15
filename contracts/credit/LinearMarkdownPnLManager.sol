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
        _updateTracker(int96(uint96(profitRateDiff)), 0, poolIncome, 0, 0);
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
            uint96(
                (principalPaid * yield * DEFAULT_DECIMALS_FACTOR) /
                    (HUNDRED_PERCENT_IN_BPS * SECONDS_IN_A_YEAR)
            )
        );
        if (oldGoodStanding) {
            _updateTracker(profitRateDiff, 0, uint96(feesPaid), 0, 0);
        } else {
            // handle recovery.
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            creditLoss.totalAccruedLoss += uint96(
                ((block.timestamp - creditLoss.lastLossUpdateDate) * creditLoss.lossRate) /
                    DEFAULT_DECIMALS_FACTOR
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

            _updateTracker(profitRateDiff, lossRateDiff, feesPaid, 0, lossRecovery);
        }
    }

    function processDefault(
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external {
        onlyCreditContract();
        CreditLoss memory creditLoss = _creditLossMap[creditHash];

        PnLTracker memory tracker = _getLatestTracker(0, 0, 0, 0, 0);
        tracker.lossRate -= creditLoss.lossRate;

        // deduct profit rate
        uint96 deductedProfitRate = uint96(
            (getPrincipal(cr) * cc.yieldInBps * DEFAULT_DECIMALS_FACTOR) /
                (HUNDRED_PERCENT_IN_BPS * SECONDS_IN_A_YEAR)
        );
        tracker.profitRate -= deductedProfitRate;

        // deduct overcalculated profit
        uint96 deductedProfit = uint96(
            (deductedProfitRate * (block.timestamp - creditLoss.lossExpiringDate)) /
                DEFAULT_DECIMALS_FACTOR
        );
        tracker.accruedProfit -= deductedProfit;

        // deduct overcalculated loss
        uint96 deductedLoss = uint96(
            (creditLoss.lossRate * (block.timestamp - creditLoss.lossExpiringDate)) /
                DEFAULT_DECIMALS_FACTOR
        );
        tracker.accruedLoss -= deductedLoss;

        pnlTracker = tracker;

        // _updateTracker(int96(0 - 1), int96(0 - lossRate), 0, 0, 0);

        creditLoss.totalAccruedLoss -= deductedLoss;
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
        onlyCreditContract();
        int96 markdownRateDiff = 0;
        uint96 markdown = 0;
        int96 profitRateDiff = int96(
            uint96(
                (principalDiff * cc.yieldInBps * DEFAULT_DECIMALS_FACTOR) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            )
        );

        if (lossImpact > 0) {
            CreditLoss memory creditLoss = _creditLossMap[creditHash];
            if (creditLoss.lastLossUpdateDate == 0) {
                // process late first time
                (markdownRateDiff, creditLoss.lossExpiringDate) = _getMarkdownRate(cr);
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
        _updateTracker(profitRateDiff, markdownRateDiff, missedProfit, markdown, 0);
    }
}
