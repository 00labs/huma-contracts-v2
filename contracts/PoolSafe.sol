// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";

contract PoolSafe is PoolConfigCache, IPoolSafe {
    struct Reserves {
        uint96 forRedemption;
        uint96 forPlatformFees;
    }

    IERC20 public underlyingToken;
    IFirstLossCover[] internal _firstLossCovers;
    IPlatformFeeManager public platformFeeManager;

    Reserves public reserves;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.platformFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        platformFeeManager = IPlatformFeeManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    function deposit(address from, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPlatformFeeManager(msg.sender);

        underlyingToken.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPlatformFeeManager(msg.sender);

        underlyingToken.transfer(to, amount);
    }

    function addPlatformFeesReserve(uint256 reserve) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        rs.forPlatformFees += uint96(reserve);
        reserves = rs;
    }

    function withdrawFees(address to, uint256 amount) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        rs.forPlatformFees -= uint96(amount);
        reserves = rs;
        underlyingToken.transfer(to, amount);
    }

    function setRedemptionReserve(uint256 reserve) external {
        poolConfig.onlyPool(msg.sender);

        Reserves memory rs = reserves;
        rs.forRedemption = uint96(reserve);
        reserves = rs;
    }

    function getAvailableLiquidity() external view returns (uint256 assets) {
        assets = totalAssets();
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets > reserve ? assets - reserve : 0;
    }

    function getAvailableReservation() external view returns (uint256 assets) {
        assets = totalAssets();
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets < reserve ? assets : reserve;
    }

    function getPoolAssets() external view returns (uint256 assets) {
        return totalAssets();
    }

    function totalAssets() public view returns (uint256 assets) {
        uint256 reserved;
        uint256 len = _firstLossCovers.length;
        for (uint256 i = 0; i < len; i++) {
            reserved += _firstLossCovers[i].totalAssets();
        }
        reserved += platformFeeManager.getTotalAvailableFees();
        uint256 balance = underlyingToken.balanceOf(address(this));
        return balance > reserved ? balance - reserved : 0;
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }
}
