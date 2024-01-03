// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, PoolSettings, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IRedemptionHandler, EpochRedemptionSummary} from "./interfaces/IRedemptionHandler.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {DEFAULT_DECIMALS_FACTOR, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {ICalendar} from "./credit/interfaces/ICalendar.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ITrancheVaultLike is IRedemptionHandler {
    function totalSupply() external view returns (uint256);
}

/**
 * @title EpochManager
 * @notice EpochManager processes redemption requests at the end of each billing cycle
 */
contract EpochManager is PoolConfigCache, IEpochManager {
    struct CurrentEpoch {
        uint64 id;
        uint64 endTime;
    }

    IPool public pool;
    IPoolSafe public poolSafe;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;
    ICalendar public calendar;

    CurrentEpoch internal _currentEpoch;

    // It is used to avoid tiny amount to be processed, e.g. 1 amount = 0.0000001 USDC remaining in the pool caused
    // by rounding down in the last epoch
    // TODO constant? Let's discuss
    uint256 public minAmountToProcessPerEpoch;

    event EpochClosed(
        uint256 epochId,
        uint256 seniorTrancheAssets,
        uint256 seniorTranchePrice,
        uint256 juniorTrancheAssets,
        uint256 juniorTranchePrice,
        uint256 unprocessedAmount
    );
    event NewEpochStarted(uint256 epochId, uint256 endTime);

    /**
     * @notice Syndicates the address of dependent contracts from pool config.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = _poolConfig.seniorTranche();
        assert(addr != address(0));
        seniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.juniorTranche();
        assert(addr != address(0));
        juniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);

        addr = _poolConfig.underlyingToken();
        assert(addr != address(0));
        uint256 decimals = IERC20Metadata(addr).decimals();
        // set minAmountToProcessPerEpoch to 1 token now
        // TODO change this to a configuration parameter?
        minAmountToProcessPerEpoch = 10 ** decimals;
    }

    /**
     * @notice Closes current epoch and handles senior and junior tranche redemption requests.
     * @dev Expects to be called by a cron-like mechanism like autotask,
     * although anyone can call it to trigger epoch closure.
     */
    function closeEpoch() public virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.closeTooSoon();

        // update tranche assets to the current timestamp
        uint96[2] memory tranchesAssets = pool.currentTranchesAssets();

        // calculate senior/junior LP token prices
        uint256 seniorPrice = (tranchesAssets[SENIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            seniorTranche.totalSupply();
        uint256 juniorPrice = (tranchesAssets[JUNIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            juniorTranche.totalSupply();

        // get unprocessed redemption requests
        EpochRedemptionSummary memory seniorSummary = seniorTranche.currentRedemptionSummary();
        EpochRedemptionSummary memory juniorSummary = juniorTranche.currentRedemptionSummary();
        uint256 unprocessedAmount;

        if (seniorSummary.totalSharesRequested > 0 || juniorSummary.totalSharesRequested > 0) {
            _processEpoch(tranchesAssets, seniorSummary, seniorPrice, juniorSummary, juniorPrice);

            seniorTranche.executeRedemptionSummary(seniorSummary);
            juniorTranche.executeRedemptionSummary(juniorSummary);

            unprocessedAmount =
                (((seniorSummary.totalSharesRequested - seniorSummary.totalSharesProcessed) *
                    seniorPrice) +
                    ((juniorSummary.totalSharesRequested - juniorSummary.totalSharesProcessed) *
                        juniorPrice)) /
                DEFAULT_DECIMALS_FACTOR;
        }

        pool.updateTranchesAssets(tranchesAssets);

        emit EpochClosed(
            ce.id,
            tranchesAssets[SENIOR_TRANCHE],
            seniorPrice,
            tranchesAssets[JUNIOR_TRANCHE],
            juniorPrice,
            unprocessedAmount
        );
        _createNextEpoch(ce);
    }

    function startNewEpoch() external {
        poolConfig.onlyPool(msg.sender);

        EpochRedemptionSummary memory seniorSummary = seniorTranche.currentRedemptionSummary();
        if (seniorSummary.totalSharesRequested > 0) {
            seniorTranche.executeRedemptionSummary(seniorSummary);
        }
        EpochRedemptionSummary memory juniorSummary = juniorTranche.currentRedemptionSummary();
        if (juniorSummary.totalSharesRequested > 0) {
            juniorTranche.executeRedemptionSummary(juniorSummary);
        }

        CurrentEpoch memory ce = _currentEpoch;
        ce.endTime = 0;
        _createNextEpoch(ce);
    }

    function _createNextEpoch(CurrentEpoch memory epoch) internal {
        epoch.id += 1;
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        uint256 nextEndTime = calendar.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            epoch.endTime
        );
        epoch.endTime = uint64(nextEndTime);
        _currentEpoch = epoch;

        emit NewEpochStarted(epoch.id, epoch.endTime);
    }

    function currentEpochId() external view returns (uint256) {
        return _currentEpoch.id;
    }

    function currentEpoch() external view returns (CurrentEpoch memory) {
        return _currentEpoch;
    }

    /**
     * @notice Process previously unprocessed redemption requests
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param seniorSummary unprocessed/partially processed redemption summary for the senior tranche
     * @param seniorPrice the senior LP token price
     * @param juniorSummary unprocessed/partially processed redemption summary for the junior tranche
     * @param juniorPrice the junior LP token price
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the tranches after fulfilling
     * redemption requests
     * seniorSummary: will be updated to reflect the latest redemption request state for the senior tranche
     * juniorSummary: will be updated to reflect the latest redemption request state for the junior tranche
     */
    function _processEpoch(
        uint96[2] memory tranchesAssets,
        EpochRedemptionSummary memory seniorSummary,
        uint256 seniorPrice,
        EpochRedemptionSummary memory juniorSummary,
        uint256 juniorPrice
    ) internal view {
        // get available underlying token amount
        uint256 availableAmount = poolSafe.getAvailableBalanceForPool();
        if (availableAmount <= minAmountToProcessPerEpoch) return;

        // Process senior tranche redemption requests.
        if (seniorSummary.totalSharesRequested > 0) {
            availableAmount = _processSeniorRedemptionRequests(
                tranchesAssets,
                seniorPrice,
                seniorSummary,
                availableAmount
            );

            if (availableAmount == 0) {
                return;
            }
        }

        // Process junior tranche redemption requests.
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
        if (juniorSummary.totalSharesRequested > 0) {
            availableAmount = _processJuniorRedemptionRequests(
                tranchesAssets,
                juniorPrice,
                maxSeniorJuniorRatio,
                juniorSummary,
                availableAmount
            );
        }
    }

    /**
     * @notice Processes redemption requests for the senior tranche
     * @param tranchesAssets tranches assets indexed by SENIOR_TRANCHE or JUNIOR_TRANCHE
     * @param lpTokenPrice the price of the senior LP tokens
     * @param redemptionSummary redemption summary for the senior tranche
     * @param availableAmount the total amount available for redemption
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the senior tranche
     * redemptionSummary: will be updated to reflect the latest redemption request states for the senior tranche
     */
    function _processSeniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        EpochRedemptionSummary memory redemptionSummary,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        uint256 sharesToRedeem = redemptionSummary.totalSharesRequested;
        uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
        if (availableAmount < redemptionAmount) {
            redemptionAmount = availableAmount;
            // Round up the number of shares the lender has to burn in order to receive
            // the amount redeemable. The result favors the pool.
            sharesToRedeem = Math.ceilDiv(
                redemptionAmount * DEFAULT_DECIMALS_FACTOR,
                lpTokenPrice
            );
        }
        redemptionSummary.totalSharesProcessed = uint96(sharesToRedeem);
        redemptionSummary.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;

        tranchesAssets[SENIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }

    /**
     * @notice Processes redemption requests for the junior tranche. When processing junior requests, special care
     * has to be taken to ensure that the max senior : junior ratio is not breached.
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param lpTokenPrice the price of the junior LP tokens
     * @param redemptionSummary redemption summary for the junior tranche
     * @param availableAmount the total amount available for redemption
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the junior tranche
     * redemptionSummary: will be updated to reflect the latest redemption request states for the senior tranche
     */
    function _processJuniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        uint256 maxSeniorJuniorRatio,
        EpochRedemptionSummary memory redemptionSummary,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        // Calculate the minimum amount of junior assets required to maintain the senior : junior ratio.
        // Since integer division rounds down, add 1 to minJuniorAmount in order to maintain the ratio.
        uint256 minJuniorAmount = tranchesAssets[SENIOR_TRANCHE] / maxSeniorJuniorRatio;
        if (minJuniorAmount * maxSeniorJuniorRatio < tranchesAssets[SENIOR_TRANCHE])
            minJuniorAmount += 1;

        uint256 maxRedeemableAmount = tranchesAssets[JUNIOR_TRANCHE] > minJuniorAmount
            ? tranchesAssets[JUNIOR_TRANCHE] - minJuniorAmount
            : 0;
        if (maxRedeemableAmount <= 0) return availableAmount;

        uint256 sharesToRedeem = redemptionSummary.totalSharesRequested;
        uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
        if (availableAmount < redemptionAmount) {
            redemptionAmount = availableAmount;
            // Round up the number of shares the lender has to burn in order to receive
            // the amount redeemable. The result favors the pool.
            sharesToRedeem = Math.ceilDiv(
                redemptionAmount * DEFAULT_DECIMALS_FACTOR,
                lpTokenPrice
            );
        }
        if (maxRedeemableAmount < redemptionAmount) {
            redemptionAmount = maxRedeemableAmount;
            // Round up the number of shares the lender has to burn in order to receive
            // the amount redeemable. The result favors the pool.
            sharesToRedeem = Math.ceilDiv(
                redemptionAmount * DEFAULT_DECIMALS_FACTOR,
                lpTokenPrice
            );
        }

        redemptionSummary.totalSharesProcessed = uint96(sharesToRedeem);
        redemptionSummary.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;
        tranchesAssets[JUNIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }
}
