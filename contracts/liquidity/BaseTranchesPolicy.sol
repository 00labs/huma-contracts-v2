// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, FirstLossCoverConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";

import "hardhat/console.sol";

abstract contract BaseTranchesPolicy is PoolConfigCache, ITranchesPolicy {
    IFirstLossCover[] internal _firstLossCovers;

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) {
                _firstLossCovers.push(IFirstLossCover(covers[i]));
            }
        }
    }

    function _distributeProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual returns (uint256 seniorProfit, uint256 remainingProfit);

    /// @inheritdoc ITranchesPolicy
    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets
    )
        external
        returns (
            uint256[2] memory profitsForTrancheVault,
            uint256[] memory profitsForFirstLossCover
        )
    {
        uint256 remainingProfit;
        (
            profitsForTrancheVault[SENIOR_TRANCHE],
            remainingProfit
        ) = _distributeProfitForSeniorTranche(profit, assets);

        // console.log(
        //     "seniorProfit: %s, remainingProfit: %s",
        //     profitsForTrancheVault[SENIOR_TRANCHE],
        //     remainingProfit
        // );

        if (remainingProfit > 0) {
            (
                profitsForTrancheVault[JUNIOR_TRANCHE],
                profitsForFirstLossCover
            ) = _calcProfitForFirstLossCovers(remainingProfit, assets[JUNIOR_TRANCHE]);
            // console.log("juniorProfit: %s", profitsForTrancheVault[JUNIOR_TRANCHE]);
        }

        return (profitsForTrancheVault, profitsForFirstLossCover);
    }

    /// @inheritdoc ITranchesPolicy
    function refreshYieldTracker(uint96[2] memory assets) public virtual {
        // Empty function for RiskAdjustedTranchePolicy
    }

    /**
     * @notice Internal function that calculates profit to first loss cover (FLC) providers
     * @dev There is a risk multiplier assigned to each first loss cover. To compute the profit
     * for each PLCs, we first gets the product of the asset amount of each PLC and the risk
     * multiplier, then add them together. We then proportionally allocate the profit to each
     * PLC based on its product of asset amount and risk multiplier. The remainer is left
     * for the junior tranche.
     * @param profit the amount of profit to be distributed between FLC and junior tranche
     * @param juniorTotalAssets the total asset amount for junior tranche
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _calcProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal view returns (uint256 juniorProfit, uint256[] memory profitsForFirstLossCovers) {
        uint256 len = _firstLossCovers.length;
        profitsForFirstLossCovers = new uint256[](len);
        // TotalWeight is the sume of the product of asset amount and risk multiplier for each FLC
        // and the junior tranche.
        uint256 totalWeight = juniorTotalAssets;
        for (uint256 i = 0; i < len; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            // profitsForFirstLossCovers is re-used to store the product of asset amount and risk
            // multiplier for each FLC for gas optimization by saving an array creation
            FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(
                address(cover)
            );
            profitsForFirstLossCovers[i] =
                (cover.totalAssets() * config.riskYieldMultiplierInBps) /
                HUNDRED_PERCENT_IN_BPS;
            totalWeight += profitsForFirstLossCovers[i];
        }

        juniorProfit = profit;
        for (uint256 i = 0; i < len; i++) {
            profitsForFirstLossCovers[i] = (profit * profitsForFirstLossCovers[i]) / totalWeight;
            // Note since profitsForFirstLossCovers[i] is rounded down by default,
            // it is guaranteed that juniorProfit will not be negative.
            juniorProfit -= profitsForFirstLossCovers[i];
        }
        return (juniorProfit, profitsForFirstLossCovers);
    }
}