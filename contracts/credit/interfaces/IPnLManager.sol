// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "../CreditStructs.sol";

interface IPnLManager {
    function processDrawdown(uint96 poolIncome, uint96 profitRateDiff) external;

    function processPayback(
        bytes32 creditHash,
        uint96 principalPaid,
        uint96 yieldPaid,
        uint96 feesPaid,
        uint16 yield,
        bool oldGoodStanding,
        bool newGoodStanding
    ) external;

    function processDefault(
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external;

    function processDueUpdate(
        uint96 principalDiff,
        uint96 missedProfit,
        bool lateFlag,
        bytes32 creditHash,
        CreditConfig memory cc,
        CreditRecord memory cr
    ) external;

    function updateTracker(
        int96 profitRateDiff,
        int96 lossRateDiff,
        uint96 profitDiff,
        uint96 lossDiff,
        uint96 recoveryDiff
    )
        external
        returns (
            uint256 incrementalProfit,
            uint256 incrementalLoss,
            uint256 incrementalLossRecovery
        );

    function refreshPnL()
        external
        returns (uint256 totalProfit, uint256 totalLoss, uint256 totalLossRecovery);

    function getPnL()
        external
        view
        returns (
            uint96 totalProfit,
            uint96 totalLoss,
            uint96 totalLossRecovery,
            uint96 profitRate,
            uint96 lossRate,
            uint64 pnlLastUpdated
        );

    function getPnLSum()
        external
        view
        returns (uint256 totalProfit, uint256 totalLoss, uint256 totalLossRecovery);
}
