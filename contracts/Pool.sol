// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, FirstLossCoverConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {ICreditManager} from "./credit/interfaces/ICreditManager.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";

import "hardhat/console.sol";

/**
 * @title Pool
 * @notice Pool is a core contract that connects the lender side (via Tranches)
 * and the borrower side (via Credit)
 */
contract Pool is PoolConfigCache, IPool {
    struct TranchesAssets {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    enum PoolStatus {
        Off,
        On
    }

    IEpochManager public epochManager;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolFeeManager public feeManager;
    IPoolSafe public poolSafe;
    ITranchesPolicy public tranchesPolicy;
    ICredit public credit;
    ICreditManager public creditManager;

    TranchesAssets public tranchesAssets;
    TranchesLosses public tranchesLosses;

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    bool public readyForFirstLossCoverWithdrawal;

    event PoolDisabled(address indexed by);
    event PoolEnabled(address indexed by);
    event PoolReadyForFirstLossCoverWithdrawal(address indexed by, bool ready);

    event PoolAssetsRefreshed(
        uint256 refreshedTimestamp,
        uint256 profit,
        uint256 loss,
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    event ProfitDistributed(uint256 profit, uint256 seniorTotalAssets, uint256 juniorTotalAssets);
    event LossDistributed(
        uint256 loss,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );
    event LossRecoveryDistributed(
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    /**
     * @notice Common function in Huma protocol to retrieve contract addresses from PoolConfig.
     * Pool contract references PoolSafe, PoolFeeManager, TranchePolicy, EpochManager, Credit,
     * CreditManager, and FirstLossCover.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.tranchesPolicy();
        assert(addr != address(0));
        tranchesPolicy = ITranchesPolicy(addr);

        addr = _poolConfig.poolFeeManager();
        assert(addr != address(0));
        feeManager = IPoolFeeManager(addr);

        addr = _poolConfig.epochManager();
        assert(addr != address(0));
        epochManager = IEpochManager(addr);

        addr = _poolConfig.credit();
        assert(addr != address(0));
        credit = ICredit(addr);

        addr = _poolConfig.creditManager();
        assert(addr != address(0));
        creditManager = ICreditManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length && covers[i] != address(0); i++) {
            _firstLossCovers.push(IFirstLossCover(covers[i]));
        }
    }

    /**
     * @notice Turns on the pool. Before a pool is turned on, the required First loss cover
     * and liquidity must be deposited first.
     * @custom:access Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        poolConfig.checkFirstLossCoverRequirementsForAdmin();
        poolConfig.checkLiquidityRequirements();

        epochManager.startNewEpoch();
        _status = PoolStatus.On;
        emit PoolEnabled(msg.sender);
    }

    /**
     * @notice Disables the pool. Once a pool is disabled, no money moves in or out.
     * @custom:access Any pool operator can disable a pool. Only the pool owner or Huma protocol
     * owner can enable it again.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    /**
     * @notice Enables or disables the first loss cover investors to withdraw capital
     * @custom:access Only pool owner or Huma protocol owner can call this function.
     */
    function setReadyForFirstLossCoverWithdrawal(bool isReady) external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        readyForFirstLossCoverWithdrawal = isReady;
        emit PoolReadyForFirstLossCoverWithdrawal(msg.sender, isReady);
    }

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        return _status == PoolStatus.On;
    }

    function getTrancheAvailableCap(uint256 index) external view returns (uint256 availableCap) {
        if (index != SENIOR_TRANCHE && index != JUNIOR_TRANCHE) return 0;
        LPConfig memory config = poolConfig.getLPConfig();
        uint96[2] memory assets = currentTranchesAssets();
        uint256 poolAssets = assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
        availableCap = config.liquidityCap > poolAssets ? config.liquidityCap - poolAssets : 0;
        if (index == SENIOR_TRANCHE) {
            uint256 seniorAvailableCap = assets[JUNIOR_TRANCHE] *
                config.maxSeniorJuniorRatio -
                assets[SENIOR_TRANCHE];
            availableCap = availableCap > seniorAvailableCap ? seniorAvailableCap : availableCap;
        }
    }

    /// custom:access only Credit or CreditManager contract can call this function.
    /// @inheritdoc IPool
    function distributeProfit(uint256 profit) external {
        // TODO(jiatu): add pool tests for non-authorized callers.
        _onlyCreditOrCreditManager(msg.sender);
        _distributeProfit(profit);
    }

    /// custom:access only Credit or CreditManager contract can call this function.
    /// @inheritdoc IPool
    function distributeLoss(uint256 loss) external {
        // TODO: Check if there are tests for non-authorized callers.
        _onlyCreditOrCreditManager(msg.sender);
        _distributeLoss(loss);
    }

    /// custom:access Only Credit contract can call this function
    /// @inheritdoc IPool
    function distributeLossRecovery(uint256 lossRecovery) external {
        if (msg.sender != address(credit)) revert Errors.notAuthorizedCaller();
        _distributeLossRecovery(lossRecovery);
    }

    /**
     * @notice Internal function that distributes profit to admins, senior and junior tranches,
     * and first loss covers in this sequence.
     * @param profit the amount of profit to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeProfit(uint256 profit) internal {
        TranchesAssets memory assets = tranchesAssets;

        // distributes to pool admins first
        uint256 poolProfit = feeManager.distributePoolFees(profit);

        if (poolProfit > 0) {
            (
                uint256[2] memory profitsForTrancheVaults,
                uint256[] memory profitsForFirstLossCovers
            ) = tranchesPolicy.distProfitToTranches(
                    poolProfit,
                    [assets.seniorTotalAssets, assets.juniorTotalAssets]
                );
            uint256[2] memory newAssets;
            newAssets[SENIOR_TRANCHE] =
                assets.seniorTotalAssets +
                profitsForTrancheVaults[SENIOR_TRANCHE];
            poolSafe.addUnprocessedProfit(
                poolConfig.seniorTranche(),
                profitsForTrancheVaults[SENIOR_TRANCHE]
            );
            newAssets[JUNIOR_TRANCHE] = assets.juniorTotalAssets;
            if (profitsForTrancheVaults[JUNIOR_TRANCHE] > 0) {
                newAssets[JUNIOR_TRANCHE] += profitsForTrancheVaults[JUNIOR_TRANCHE];
                poolSafe.addUnprocessedProfit(
                    poolConfig.juniorTranche(),
                    profitsForTrancheVaults[JUNIOR_TRANCHE]
                );
            }

            uint256 len = profitsForFirstLossCovers.length;
            for (uint256 i = 0; i < len; i++) {
                if (profitsForFirstLossCovers[i] == 0) {
                    continue;
                }
                IFirstLossCover cover = _firstLossCovers[i];
                cover.addCoverAssets(profitsForFirstLossCovers[i]);
            }

            // Don't call _updateTranchesAssets() here because yield tracker has already
            // been updated in distProfitToTranches().
            // TODO Not sure if it is a good practice to update state in tranchesPolicy.
            // Let us discuss we need to change it.
            tranchesAssets = TranchesAssets({
                seniorTotalAssets: uint96(newAssets[SENIOR_TRANCHE]),
                juniorTotalAssets: uint96(newAssets[JUNIOR_TRANCHE])
            });
            emit ProfitDistributed(profit, newAssets[SENIOR_TRANCHE], newAssets[JUNIOR_TRANCHE]);
        }
    }

    /**
     * @notice Utility function that distributes loss to different tranches。
     * The loss is distributed to first loss cover first, then junior tranche, and senior tranche
     * @param loss the amount of loss to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeLoss(uint256 loss) internal {
        if (loss > 0) {
            uint256 coverCount = _firstLossCovers.length;
            for (uint256 i = 0; i < coverCount && loss > 0; i++) {
                loss = _firstLossCovers[i].coverLoss(loss);
            }

            if (loss > 0) {
                // If there are losses remaining, let the junior and senior tranches cover the losses.
                _distLossToTranches(loss);
            }
        }
    }

    /**
     * @notice Distributes loss to tranches
     * @param loss the loss amount
     */
    function _distLossToTranches(uint256 loss) internal {
        TranchesAssets memory assets = tranchesAssets;
        uint256 juniorTotalAssets = assets.juniorTotalAssets;
        // Distribute losses to junior tranche up to the total junior asset
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        uint256 seniorLoss = loss - juniorLoss;

        assets.seniorTotalAssets -= uint96(seniorLoss);
        assets.juniorTotalAssets -= uint96(juniorLoss);
        _updateTranchesAssets([assets.seniorTotalAssets, assets.juniorTotalAssets]);
        TranchesLosses memory losses = tranchesLosses;
        losses.seniorLoss += uint96(seniorLoss);
        losses.juniorLoss += uint96(juniorLoss);
        tranchesLosses = losses;

        emit LossDistributed(
            loss,
            assets.seniorTotalAssets,
            assets.juniorTotalAssets,
            losses.seniorLoss,
            losses.juniorLoss
        );
    }

    /**
     * @notice Utility function that distributes loss recovery to different tranches and
     * First Loss Covers (FLCs). The distribution sequence is: senior tranche, junior tranche,
     * followed by FLCs
     * @param lossRecovery the amount of loss to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeLossRecovery(uint256 lossRecovery) internal {
        if (lossRecovery > 0) {
            uint256 remainingLossRecovery = _distLossRecoveryToTranches(lossRecovery);

            // Distributes the remainder to First Loss Covers.
            uint256 numFirstLossCovers = _firstLossCovers.length;
            for (uint256 i = 0; i < numFirstLossCovers && remainingLossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[numFirstLossCovers - i - 1];
                remainingLossRecovery = cover.recoverLoss(remainingLossRecovery);
            }
        }
    }

    /**
     * @notice Distributes loss recovery to tranches
     * @param lossRecovery the loss recovery amount
     * @return remainingLossRecovery the remaining loss recovery after distributing among tranches
     */
    function _distLossRecoveryToTranches(
        uint256 lossRecovery
    ) internal returns (uint256 remainingLossRecovery) {
        TranchesAssets memory assets = tranchesAssets;
        TranchesLosses memory losses = tranchesLosses;
        uint96 seniorLoss = losses.seniorLoss;
        // Allocates recovery to senior first, up to the total senior losses
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets.seniorTotalAssets += uint96(seniorLossRecovery);
            losses.seniorLoss -= uint96(seniorLossRecovery);
        }

        remainingLossRecovery = lossRecovery - seniorLossRecovery;
        if (remainingLossRecovery > 0) {
            uint96 juniorLoss = losses.juniorLoss;
            uint256 juniorLossRecovery = remainingLossRecovery >= juniorLoss
                ? juniorLoss
                : remainingLossRecovery;
            assets.juniorTotalAssets += uint96(juniorLossRecovery);
            losses.juniorLoss -= uint96(juniorLossRecovery);
            remainingLossRecovery = remainingLossRecovery - juniorLossRecovery;
        }

        _updateTranchesAssets([assets.seniorTotalAssets, assets.juniorTotalAssets]);
        tranchesLosses = losses;

        emit LossRecoveryDistributed(
            lossRecovery - remainingLossRecovery,
            assets.seniorTotalAssets,
            assets.juniorTotalAssets,
            losses.seniorLoss,
            losses.juniorLoss
        );

        return remainingLossRecovery;
    }

    /**
     * @notice Gets the total asset of a tranche
     * @param index the tranche index.
     * @return the total asset of the tranche.
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    /**
     * @notice Gets the combined total asset of junior tranche and senior tranche.
     * @return - the total asset of both junior and senior tranches
     */
    function totalAssets() public view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
    }

    /**
     * @notice Gets the assets for each tranche
     * @return assets the tranche assets in an array.
     */
    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        return [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
    }

    /**
     * @notice Updates the tranche assets with the given asset values
     * @param assets an array that represents the tranche asset
     * @custom:access Only TrancheVault or Epoch Manager can call this function
     */
    function updateTranchesAssets(uint96[2] memory assets) external {
        _onlyTrancheVaultOrEpochManager(msg.sender);
        _updateTranchesAssets(assets);
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    /**
     * @notice Utility function to update tranche assets
     * @param assets an array that represents the desired tranche asset
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _updateTranchesAssets(uint96[2] memory assets) internal {
        tranchesAssets = TranchesAssets({
            seniorTotalAssets: assets[SENIOR_TRANCHE],
            juniorTotalAssets: assets[JUNIOR_TRANCHE]
        });
        tranchesPolicy.refreshYieldTracker(assets);
    }

    function _onlyTrancheVaultOrEpochManager(address account) internal view {
        if (
            account != poolConfig.juniorTranche() &&
            account != poolConfig.seniorTranche() &&
            account != poolConfig.epochManager()
        ) revert Errors.notAuthorizedCaller();
    }

    function _onlyCreditOrCreditManager(address account) internal view {
        if (account != address(credit) && account != address(creditManager)) {
            revert Errors.notAuthorizedCaller();
        }
    }
}
