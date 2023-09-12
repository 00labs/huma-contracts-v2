// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {PoolConfig} from "../PoolConfig.sol";

abstract contract BasePnLManager is PoolConfigCache, IPnLManager {
    PnLTracker internal pnlTracker;

    ICredit internal _credit;

    mapping(bytes32 => CreditLoss) internal _creditLossMap;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        _credit = ICredit(addr);
    }

    function getPrincipal(CreditRecord memory cr) internal pure returns (uint96 principal) {
        principal = cr.unbilledPrincipal + cr.totalDue - cr.feesDue - cr.yieldDue;
    }

    function _getMarkdownRate(
        CreditConfig memory cc,
        CreditRecord memory cr
    ) internal view returns (int96 markdownRate) {
        uint16 gracePeriodInCU = poolConfig.getPoolSettings().defaultGracePeriodInCalendarUnit;
        uint256 gracePeriod = gracePeriodInCU * SECONDS_IN_A_DAY;
        if (cc.calendarUnit == CalendarUnit.Month) gracePeriod *= 30;
        markdownRate = int96(uint96(getPrincipal(cr) / gracePeriod));
    }

    function _updateTracker(
        int96 profitRateDiff,
        int96 lossRateDiff,
        uint96 profitDiff,
        uint96 lossDiff,
        uint96 recoveryDiff
    ) internal {
        pnlTracker = _getLatestTracker(
            profitRateDiff,
            lossRateDiff,
            profitDiff,
            lossDiff,
            recoveryDiff
        );
    }

    function _getLatestTracker(
        int96 profitRateDiff,
        int96 lossRateDiff,
        uint96 profitDiff,
        uint96 lossDiff,
        uint96 recoveryDiff
    ) internal view returns (PnLTracker memory newTracker) {
        PnLTracker memory tracker = pnlTracker;
        uint256 timeLapsed = block.timestamp - tracker.pnlLastUpdated;

        newTracker.profitRate = uint96(int96(tracker.profitRate) + profitRateDiff);
        newTracker.lossRate = uint96(int96(tracker.lossRate) + lossRateDiff);
        newTracker.accruedProfit =
            tracker.accruedProfit +
            profitDiff +
            uint96(tracker.profitRate * timeLapsed);
        newTracker.accruedLoss =
            tracker.accruedLoss +
            lossDiff +
            uint96(tracker.lossRate * timeLapsed);
        newTracker.accruedLossRecovery = tracker.accruedLossRecovery + recoveryDiff;
        newTracker.pnlLastUpdated = uint64(block.timestamp);
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
        returns (uint256 accruedProfit, uint256 accruedLoss, uint256 accruedLossRecovery)
    {
        PnLTracker memory t = _getLatestTracker(0, 0, 0, 0, 0);
        accruedProfit = t.accruedProfit;
        accruedLoss = t.accruedLoss;
        accruedLossRecovery = t.accruedLossRecovery;

        t.accruedProfit = 0;
        t.accruedLoss = 0;
        t.accruedLossRecovery = 0;
        pnlTracker = t;
    }

    function getPnL()
        external
        view
        virtual
        override
        returns (
            uint96 accruedProfit,
            uint96 accruedLoss,
            uint96 accruedLossRecovery,
            uint96 profitRate,
            uint96 lossRate,
            uint64 pnlLastUpdated
        )
    {
        PnLTracker memory _t = _getLatestTracker(0, 0, 0, 0, 0);
        return (
            _t.accruedProfit,
            _t.accruedLoss,
            _t.accruedLossRecovery,
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
        returns (uint256 accruedProfit, uint256 accruedLoss, uint256 accruedLossRecovery)
    {
        PnLTracker memory _t = _getLatestTracker(0, 0, 0, 0, 0);
        return (
            uint256(_t.accruedProfit),
            uint256(_t.accruedLoss),
            uint256(_t.accruedLossRecovery)
        );
    }

    function onlyCreditContract() internal view {
        if (msg.sender != address(_credit)) revert Errors.todo();
    }
}
