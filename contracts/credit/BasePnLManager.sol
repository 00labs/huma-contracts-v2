// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {PnLTracker, CreditLoss, CreditRecord, CreditConfig} from "./CreditStructs.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";

import "hardhat/console.sol";

abstract contract BasePnLManager is PoolConfigCache, IPnLManager {
    ICredit public credit;
    ICalendar public calendar;

    PnLTracker internal pnlTracker;
    mapping(bytes32 => CreditLoss) internal _creditLossMap;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = ICredit(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    function getPrincipal(CreditRecord memory cr) internal pure returns (uint96 principal) {
        principal = cr.unbilledPrincipal + cr.totalDue - cr.feesDue - cr.yieldDue;
    }

    function _getMarkdownRate(
        CreditRecord memory cr
    ) internal view returns (int96 markdownRate, uint64 lossEndDate) {
        PoolSettings memory settings = poolConfig.getPoolSettings();
        lossEndDate = uint64(
            calendar.getNextPeriod(
                settings.calendarUnit,
                settings.defaultGracePeriodInCalendarUnit,
                cr.nextDueDate
            )
        );
        markdownRate = int96(
            uint96((getPrincipal(cr) * DEFAULT_DECIMALS_FACTOR) / (lossEndDate - cr.nextDueDate))
        );
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
        uint256 timeLapsed;
        if (tracker.pnlLastUpdated > 0) timeLapsed = block.timestamp - tracker.pnlLastUpdated;

        // console.log(
        //     "timeLapsed: %s, profitRate: %s, lossRate: %s",
        //     timeLapsed,
        //     uint256(tracker.profitRate),
        //     uint256(tracker.lossRate)
        // );

        newTracker.accruedProfit =
            tracker.accruedProfit +
            profitDiff +
            uint96((tracker.profitRate * timeLapsed) / DEFAULT_DECIMALS_FACTOR);
        newTracker.accruedLoss =
            tracker.accruedLoss +
            lossDiff +
            uint96((tracker.lossRate * timeLapsed) / DEFAULT_DECIMALS_FACTOR);
        newTracker.accruedLossRecovery = tracker.accruedLossRecovery + recoveryDiff;
        newTracker.profitRate = uint96(int96(tracker.profitRate) + profitRateDiff);
        newTracker.lossRate = uint96(int96(tracker.lossRate) + lossRateDiff);
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

    function getCreditLoss(bytes32 creditHash) external view returns (CreditLoss memory) {
        return _creditLossMap[creditHash];
    }

    function onlyCreditContract() internal view {
        if (msg.sender != address(credit)) revert Errors.todo();
    }
}
