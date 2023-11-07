// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";

/**
 * @title PoolSafe
 * @notice PoolSafe tracks the in flow and out flow of underlying tokens
 */
contract PoolSafe is PoolConfigCache, IPoolSafe {
    IERC20 public underlyingToken;
    IPool public pool;
    IPoolFeeManager public poolFeeManager;

    // This mapping contains the unprocessed profit for junior tranche and senior tranche.
    // The key is junior/senior tranche address, the value is the unprocessed profit.
    mapping(address => uint256) public unprocessedTrancheProfit;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = IPoolFeeManager(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);
    }

    /// @inheritdoc IPoolSafe
    function deposit(address from, uint256 amount) external virtual {
        _onlyCustodian(msg.sender);

        underlyingToken.transferFrom(from, address(this), amount);
    }

    /// @inheritdoc IPoolSafe
    function withdraw(address to, uint256 amount) external virtual {
        if (to == address(0)) revert Errors.zeroAddressProvided();
        _onlyCustodian(msg.sender);

        underlyingToken.transfer(to, amount);
    }

    function addUnprocessedProfit(address tranche, uint256 profit) external {
        if (msg.sender != address(pool)) revert Errors.notAuthorizedCaller();
        if (tranche != poolConfig.seniorTranche() && tranche != poolConfig.juniorTranche())
            revert Errors.todo();
        unprocessedTrancheProfit[tranche] += profit;
    }

    function removeProcessedProfit(uint256 profit) external {
        if (msg.sender != poolConfig.seniorTranche() && msg.sender != poolConfig.juniorTranche())
            revert Errors.notAuthorizedCaller();
        unprocessedTrancheProfit[msg.sender] -= profit;
    }

    /// @inheritdoc IPoolSafe
    function getPoolLiquidity() external view virtual returns (uint256 liquidity) {
        uint256 reserved = pool.getReservedAssetsForFirstLossCovers();
        reserved += poolFeeManager.getTotalAvailableFees();
        reserved +=
            unprocessedTrancheProfit[poolConfig.seniorTranche()] +
            unprocessedTrancheProfit[poolConfig.juniorTranche()];
        uint256 balance = underlyingToken.balanceOf(address(this));
        liquidity = balance > reserved ? balance - reserved : 0;
    }

    /// @inheritdoc IPoolSafe
    function totalLiquidity() external view returns (uint256 liquidity) {
        liquidity = underlyingToken.balanceOf(address(this));
    }

    /// @inheritdoc IPoolSafe
    function getAvailableLiquidityForFees() external view returns (uint256 liquidity) {
        uint256 balance = underlyingToken.balanceOf(address(this));
        uint256 reserved = pool.getReservedAssetsForFirstLossCovers();
        liquidity = balance > reserved ? balance - reserved : 0;
    }

    function _onlyCustodian(address account) internal view {
        if (
            account != poolConfig.seniorTranche() &&
            account != poolConfig.juniorTranche() &&
            account != poolConfig.credit() &&
            account != poolConfig.poolFeeManager() &&
            !poolConfig.isFirstLossCoverOrProfitEscrow(account)
        ) revert Errors.notAuthorizedCaller();
    }
}
