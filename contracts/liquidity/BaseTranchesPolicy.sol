// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, FirstLossCoverConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {Errors} from "../common/Errors.sol";

abstract contract BaseTranchesPolicy is PoolConfigCache, ITranchesPolicy {
    IFirstLossCover[] internal _firstLossCovers;
    address public pool;

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
        if (msg.sender != pool) revert Errors.AuthorizedContractCallerRequired();

        // Distributes profits to the senior tranche first.
        uint256 remainingProfit;
        (
            profitsForTrancheVault[SENIOR_TRANCHE],
            remainingProfit
        ) = _distributeProfitForSeniorTranche(profit, assets);

        // Then distribute the remainder to the junior tranche and first loss covers.
        if (remainingProfit > 0) {
            (
                profitsForTrancheVault[JUNIOR_TRANCHE],
                profitsForFirstLossCover
            ) = _calcProfitForFirstLossCovers(remainingProfit, assets[JUNIOR_TRANCHE]);
        }

        return (profitsForTrancheVault, profitsForFirstLossCover);
    }

    /// @inheritdoc ITranchesPolicy
    function refreshYieldTracker(uint96[2] memory assets) external virtual {
        // Intentionally left empty for the default implementation since most tranche policies don't need
        // to refresh the yield tracker.
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        address addr = poolConfig_.pool();
        assert(addr != address(0));
        pool = addr;

        delete _firstLossCovers;
        address[16] memory covers = poolConfig_.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) {
                _firstLossCovers.push(IFirstLossCover(covers[i]));
            }
        }
    }

    /**
     * @notice Calculates the amount of profit that should be distributed to the senior tranche.
     * @dev Concrete tranche policies should override this function and define their own policy for distribution.
     * @param profit The total amount of profit to distribute among tranches and first loss covers.
     * @param assets The assets for each tranche, assets[0] for the senior tranche and assets[1] for the junior tranche.
     * @return seniorProfit The amount of profit that should be distributed to the senior tranche.
     * @return remainingProfit The remaining amount of profit that should be distributed to other parties.
     */
    function _distributeProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual returns (uint256 seniorProfit, uint256 remainingProfit);

    /**
     * @notice Internal function that calculates the profit distribution between the junior trnache and
     * first loss covers (FLCs).
     * @dev There is a risk multiplier assigned to each first loss cover. To compute the profit
     * for each FLCs, we first get the product of the asset amount of each FLC and the risk
     * multiplier, then add them together. We then proportionally allocate the profit to each
     * FLC based on its product of asset amount and risk multiplier. The remainder is left
     * for the junior tranche.
     * @param profit The amount of profit to be distributed between FLC and junior tranche.
     * @param juniorTotalAssets The total amount of asset for junior tranche.
     * @return juniorProfit The amount of profit that the junior tranche will take.
     * @return profitsForFirstLossCovers The amount of profit that each FLC will take.
     * @custom:access Internal function without access restriction. Callers need to control access.
     */
    function _calcProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal view returns (uint256 juniorProfit, uint256[] memory profitsForFirstLossCovers) {
        uint256 len = _firstLossCovers.length;
        profitsForFirstLossCovers = new uint256[](len);
        // `totalWeight` is the sum of the product of asset amount and risk multiplier for each FLC
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
