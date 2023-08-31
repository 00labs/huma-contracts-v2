// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";

abstract contract BasePnLManager is IPnLManager {
    PoolConfig internal _poolConfig;

    PnLTracker pnlTracker;

    mapping(bytes32 => CreditLoss) internal _creditLossMap;

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
