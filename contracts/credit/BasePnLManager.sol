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
    )
        internal
        returns (
            uint256 incrementalProfit,
            uint256 incrementalLoss,
            uint256 incrementalLossRecovery
        )
    {
        PnLTracker memory t = pnlTracker;
        uint256 timeLapsed = block.timestamp - t.pnlLastUpdated;

        incrementalProfit = uint256(profitDiff + uint96(t.profitRate * timeLapsed));
        incrementalLoss = uint256(lossDiff + uint96(t.lossRate * timeLapsed));
        incrementalLossRecovery = uint256(recoveryDiff);

        t.profitRate = uint96(int96(t.profitRate) + profitRateDiff);
        t.lossRate = uint96(int96(t.lossRate) + lossRateDiff);
        t.totalProfit = uint96(t.totalProfit + incrementalProfit);
        t.totalLoss = uint96(t.totalLoss + incrementalLoss);
        t.totalLossRecovery = uint96(t.totalLossRecovery + incrementalLossRecovery);
        t.pnlLastUpdated = uint64(block.timestamp);
        pnlTracker = t;
    }

    function getIncrementalPnL()
        public
        view
        returns (
            uint256 incrementalProfit,
            uint256 incrementalLoss,
            uint256 incrementalLossRecovery
        )
    {
        PnLTracker memory t = pnlTracker;
        uint256 timeLapsed = block.timestamp - t.pnlLastUpdated;

        incrementalProfit = uint256(t.profitRate * timeLapsed);
        incrementalLoss = uint256(t.lossRate * timeLapsed);
        incrementalLossRecovery = 0;
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
        return _updateTracker(0, 0, 0, 0, 0);
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

    function onlyCreditContract() internal view {
        if (msg.sender != address(_credit)) revert Errors.todo();
    }
}
